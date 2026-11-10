// Upgrade steward: keeps a checkout of a repository on its disk with the dependencies installed, watches
// the npm packages it depends on, and tries each new release on a branch of the whole disk: install it,
// run the tests, keep the branch. When the tests pass it asks whether to open a pull request, and asks
// GitHub for one only after I approve. It is deterministic: no model. See README.md.

import { defineSystem, type Turn } from "@standing-systems/atoll";

/**
 * What I asked for, in my words. Atoll writes it into a new atoll's CHARTER.md under the system's name,
 * followed by each part's purpose; a test checks that the result is the CHARTER.md beside this file.
 */
const charter = `I maintain a repository, and the packages it depends on move faster than I can check them.

Keep a checkout of the repository I name on your disk, with its dependencies installed, and bring it up
to date every six hours. Watch every package it depends on. When one publishes a version newer than the
one the repository has, try it: on a copy of the whole checkout, install that version and run the tests.
Tell me what happened, with the output, and keep the copy so I can look at it.

If the tests pass, ask me whether to open a pull request, and ask GitHub for it only when I say yes. If
they fail, tell me and stop there.

A trial means something only if the repository's own tests pass without the upgrade. Run them whenever
the checkout changes. While they fail, hold every trial, and tell me once.

## Never

- Never change the repository. A trial happens on a copy, and a pull request is the repository's own
  workflow making the change after I approve it.
- Never open a pull request, or ask for one, without my approval of that exact upgrade.
- Never blame an upgrade for tests that were already failing.
- Never try the same version of a package twice unless I ask.
- Never try a prerelease.
- Never ask npm more than 10,000 times in a month, sync more than 400 times, or run more than 300
  trials.
- Never change which repository you keep, or your own code, without me.`;

/** Failed checks in a row before a watch tells me. One failure is usually the network. */
const FAILURES_BEFORE_TELLING = 3;
/** Lines of a command's output kept beside a trial. The whole output is in the evidence. */
const OUTPUT_LINES = 40;
/** Lines of it quoted in a notice: the end of a test run is where it says what failed. */
const QUOTED_LINES = 15;
/** What the runner doesn't walk after a command: the installed packages, git's objects, and the commands' own logs. */
const IGNORED = ["node_modules", ".git", ".steward"];
/** The line a command ends its output with: this word, then its summary as JSON. */
const MARK = "__STEWARD__";

// ---- What the parts keep on disk ---------------------------------------------------------------------

type Section = "dependencies" | "devDependencies" | "optionalDependencies";
const SECTIONS: Section[] = ["dependencies", "devDependencies", "optionalDependencies"];

/** How the repository's own tests did at a commit, before any upgrade. */
interface Baseline {
  head: string;
  passed: boolean;
  at: string;
  seconds: number;
  evidence: string[];
}

/** parts/repo/repo.json: the repository this steward keeps, and where its checkout stands. */
interface RepoFile {
  url: string;
  /** "owner/name" on GitHub. */
  github: string;
  /** The branch or tag it follows, or null for the default branch. */
  ref: string | null;
  /** The command that runs the tests. */
  test: string;
  since: string;
  /** The commit the checkout is at, once it has synced. */
  head: string | null;
  syncedAt: string | null;
  baseline: Baseline | null;
}

/** One entry of parts/repo/deps.json: a package the repository depends on directly. */
export interface Dep {
  name: string;
  section: Section;
  /** What package.json asks for, such as "^5.0.4". */
  spec: string;
  /** The version in node_modules, or null when it isn't installed. */
  installed: string | null;
}

/** parts/repo/health.json and parts/watch/<instance>/health.json: there only while something is failing. */
interface HealthFile {
  failures: number;
  since: string;
  lastAt: string;
  lastError: string;
  evidence: string[];
}

/** parts/watch/<instance>/watch.json: the dependency this watch follows, as the repository has it. */
interface WatchFile extends Dep {
  since: string;
}

/** parts/watch/<instance>/latest.json: the version npm last called latest, and whether it went to a trial. */
interface LatestFile {
  version: string;
  seenAt: string;
  /** The trial it was sent to, or null when it wasn't newer than what the repository has. */
  trial: string | null;
  evidence: string[];
}

type TrialState = "held" | "running" | "passed" | "failed" | "not-installable" | "errored";

/** parts/trial/<instance>/trial.json: one version of one package, tried once. */
interface TrialFile extends Classification {
  package: string;
  version: string;
  /** The version the repository had. */
  from: string | null;
  section: Section;
  spec: string;
  state: TrialState;
  /** Why it is held or errored, in a sentence. */
  detail: string | null;
  /** The commit it was tried against. */
  head: string | null;
  requestedAt: string;
  finishedAt: string | null;
  /** The disk branch that holds the checkout as the trial left it. */
  branch: string | null;
  checkpoint: string | null;
  seconds: { install: number; test: number } | null;
  /** The tracked files the upgrade changed. */
  changed: string[];
  evidence: string[];
  pull: { state: "asked" | "requested" | "declined" | "not-requested" | "unknown"; at: string; detail: string | null } | null;
}

/** The body of an effect's result event. */
interface EffectResult<R> {
  ok: boolean;
  effect: string;
  name: string;
  result?: R;
  error?: string;
  denied?: boolean;
  inDoubt?: boolean;
}

interface HttpResult {
  status?: number;
  json?: unknown;
  text?: string;
}

/** What an exec effect answers with. A forked one that isn't merged also names its branch. */
interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  branch?: string;
  checkpoint?: string;
}

/** What `repo.sync` ends its output with. */
interface SyncSummary {
  kind: "sync";
  stage: "git" | "install" | "done";
  head?: string;
  /** "0", another exit code, or "skipped" when nothing had changed since the last run. */
  install?: string;
  test?: string;
  seconds?: number;
  deps?: Dep[];
}

/** What `trial.run` ends its output with. */
interface TrialSummary {
  kind: "trial";
  stage: "install" | "test";
  head: string;
  /** The version of the package in node_modules after the install. */
  installed: string | null;
  install: number;
  test: number | null;
  installSeconds: number;
  testSeconds: number;
  changed: string[];
}

/** The arguments of `pr.open`, which are what I approve. */
export interface PullArgs {
  repo: string;
  package: string;
  version: string;
  from: string | null;
  section: Section;
  save: string;
  head: string;
  trial: string;
  branch: string | null;
  evidence: string[];
}

// ---- npm names, versions, and instance names ---------------------------------------------------------

/** npm's rule for package names, scoped or not. It also keeps a name safe inside a command. */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
/** What a version must look like before it goes into a command or a name. */
const VERSION_TEXT = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
/** A public repository on GitHub, over HTTPS. The command that clones it holds no credentials. */
const REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** Specs that aren't a version on the registry: a path, a git or tarball URL, a workspace, an alias. */
const NOT_ON_THE_REGISTRY = /^(?:file:|link:|git[+:]|github:|https?:|workspace:|npm:)|\//;

export function isPackageName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 214 && PACKAGE_NAME.test(name);
}

/** The registry's document for a package's latest version: a few KB, the same until a release. */
export function latestUrl(name: string): string {
  return `https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

function parseVersion(text: string | null): Semver | null {
  const m = text === null ? null : SEMVER.exec(text);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null } : null;
}

function isNewer(a: Semver, b: Semver): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch > b.patch;
}

export type Change = "major" | "minor" | "patch" | "prerelease" | "not-newer" | "unknown";

export interface Classification {
  change: Change;
  /** Whether it is worth a trial: a stable version newer than what the repository has. */
  upgrade: boolean;
  reason: string;
}

/** Judges npm's latest version against the one the repository has installed. */
export function classify(version: string, installed: string | null): Classification {
  const v = parseVersion(version);
  if (!v) return { change: "unknown", upgrade: false, reason: `"${version}" isn't a semver version` };
  if (v.pre !== null) return { change: "prerelease", upgrade: false, reason: "a prerelease" };
  const have = parseVersion(installed);
  if (!have) return { change: "unknown", upgrade: false, reason: "the repository's version isn't known, so there is nothing to compare it with" };
  if (!isNewer(v, have)) return { change: "not-newer", upgrade: false, reason: `not newer than ${installed}, which the repository has` };
  if (v.major !== have.major) return { change: "major", upgrade: true, reason: `a major release after ${installed}` };
  if (v.minor !== have.minor) return { change: "minor", upgrade: true, reason: `a minor release after ${installed}` };
  return { change: "patch", upgrade: true, reason: `a patch after ${installed}` };
}

/** An FNV-1a hash as eight hex digits: enough to tell two long names apart. */
function hash8(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/**
 * A part instance's name: lowercase letters, digits, ".", "_" and "-", starting with a letter or digit,
 * at most 64 characters. "@types/node" becomes "types__node".
 */
export function slug(text: string): string {
  const plain = text.toLowerCase().replace(/^@/, "").replace(/\//g, "__").replace(/[^a-z0-9._-]/g, "_").replace(/^[._-]+/, "");
  if (plain.length > 0 && plain.length <= 64) return plain;
  return `${plain.slice(0, 55) || "x"}-${hash8(text)}`;
}

export const watchAddress = (name: string) => `watch/${slug(name)}`;
export const trialAddress = (name: string, version: string) => `trial/${slug(`${name}-${version}`)}`;

/** A dependency worth watching: a registry package with a readable installed version. */
function watchable(dep: Dep): boolean {
  return dep.installed !== null && parseVersion(dep.installed) !== null && !NOT_ON_THE_REGISTRY.test(dep.spec);
}

function asDep(value: unknown): Dep | null {
  const d = value as Partial<Dep> | null;
  if (!d || !isPackageName(d.name) || !SECTIONS.includes(d.section as Section) || typeof d.spec !== "string") return null;
  const installed = typeof d.installed === "string" && VERSION_TEXT.test(d.installed) ? d.installed : null;
  return { name: d.name, section: d.section as Section, spec: d.spec.slice(0, 200), installed };
}

// ---- The two commands ---------------------------------------------------------------------------------
//
// Both run in a microVM with the atoll's workspace as their directory, and neither holds a credential.
// Every value that reaches them is checked first and single-quoted anyway. Each writes its noisy output
// to a log under .steward/, prints the end of it, and finishes with one line: MARK and a JSON summary.

/** Single-quote a string for sh. */
const q = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** Where the logs go, and word to git, npm and test runners that nobody is watching: no prompts, no colour. */
const PREAMBLE = `W=$(pwd); mkdir -p .steward; export CI=1 NO_COLOR=1 GIT_TERMINAL_PROMPT=0`;

/** Prints `repo.sync`'s summary. Runs with node -e, so it has no single quotes in it. */
const SYNC_SUMMARY = [
  `const fs = require("fs");`,
  `const [head, install, test, seconds] = process.argv.slice(1);`,
  `const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));`,
  `const deps = [];`,
  `for (const section of ${JSON.stringify(SECTIONS)}) for (const [name, spec] of Object.entries(pkg[section] || {})) {`,
  `  let installed = null;`,
  `  try { installed = JSON.parse(fs.readFileSync("node_modules/" + name + "/package.json", "utf8")).version; } catch {}`,
  `  deps.push({ name, section, spec: String(spec), installed });`,
  `}`,
  `console.log("${MARK} " + JSON.stringify({ kind: "sync", stage: "done", head, install, test, seconds: Number(seconds), deps }));`,
].join(" ");

/** Prints `trial.run`'s summary. */
const TRIAL_SUMMARY = [
  `const fs = require("fs");`,
  `const [stage, head, name, install, test, installSeconds, testSeconds, changed] = process.argv.slice(1);`,
  `let installed = null;`,
  `try { installed = JSON.parse(fs.readFileSync("node_modules/" + name + "/package.json", "utf8")).version; } catch {}`,
  `console.log("${MARK} " + JSON.stringify({ kind: "trial", stage, head, installed, install: Number(install), test: test === "" ? null : Number(test), installSeconds: Number(installSeconds), testSeconds: Number(testSeconds), changed: changed.split("\\n").filter(Boolean) }));`,
].join(" ");

/**
 * Bring the checkout in workspace/repo to the head of what it follows, install its dependencies if
 * package.json or the lockfile changed, and run the tests if anything did. `knownHead` is the commit
 * whose tests are already on record; a sync that finds the checkout still there skips them.
 */
export function syncCommand(repo: { url: string; ref: string | null; test: string }, knownHead: string | null): string {
  const fetch = `git fetch --quiet --depth 1 origin ${q(repo.ref ?? "HEAD")}`;
  const clone = `git clone --quiet --depth 1${repo.ref ? ` --branch ${q(repo.ref)}` : ""} ${q(repo.url)} repo`;
  return [
    PREAMBLE,
    `if [ -d repo/.git ]; then`,
    `  cd repo && git remote set-url origin ${q(repo.url)} && ${fetch} > "$W/.steward/git.log" 2>&1 && git reset --quiet --hard FETCH_HEAD >> "$W/.steward/git.log" 2>&1`,
    `else`,
    `  ${clone} > "$W/.steward/git.log" 2>&1 && cd repo`,
    `fi`,
    `GIT=$?`,
    `if [ "$GIT" -ne 0 ]; then tail -n 20 "$W/.steward/git.log"; echo '${MARK} {"kind":"sync","stage":"git"}'; exit 91; fi`,
    `HEAD_SHA=$(git rev-parse HEAD)`,
    // The blobs of package.json and the lockfile at this commit: installing again is needed only when one changed.
    `KEY="$(git rev-parse -q --verify HEAD:package.json) $(git rev-parse -q --verify HEAD:package-lock.json)"`,
    `INSTALL=skipped`,
    `if [ ! -d node_modules ] || [ "$(cat node_modules/.steward-installed 2>/dev/null)" != "$KEY" ]; then`,
    `  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund > "$W/.steward/install.log" 2>&1; else npm install --no-audit --no-fund > "$W/.steward/install.log" 2>&1; fi`,
    `  INSTALL=$?`,
    `  if [ "$INSTALL" -ne 0 ]; then tail -n 20 "$W/.steward/install.log"; echo '${MARK} {"kind":"sync","stage":"install"}'; exit 92; fi`,
    `  printf %s "$KEY" > node_modules/.steward-installed`,
    `fi`,
    `TEST=skipped; SECS=0`,
    `if [ "$HEAD_SHA" != ${q(knownHead ?? "")} ] || [ "$INSTALL" != skipped ]; then`,
    `  T0=$(date +%s); ( ${repo.test} ) > "$W/.steward/test.log" 2>&1; TEST=$?; SECS=$(( $(date +%s) - T0 ))`,
    `  tail -n ${OUTPUT_LINES} "$W/.steward/test.log"`,
    `fi`,
    `node -e ${q(SYNC_SUMMARY)} "$HEAD_SHA" "$INSTALL" "$TEST" "$SECS"`,
  ].join("\n");
}

/** The flags that make npm write the new version the way package.json wrote the old one. */
export function saveFlags(section: Section, spec: string): string {
  const where = section === "devDependencies" ? "--save-dev" : section === "optionalDependencies" ? "--save-optional" : "--save-prod";
  if (/^\d/.test(spec)) return `${where} --save-exact`;
  return spec.startsWith("~") ? `${where} --save-prefix=~` : where;
}

/**
 * Install one version of one package into the checkout and run the tests. It runs on a branch of the
 * disk, so the checkout it changes is a copy that already has every other dependency installed. It
 * exits with the tests' exit code, or 91 when the install failed.
 */
export function trialCommand(trial: { package: string; version: string; section: Section; spec: string }, test: string): string {
  const summary = (stage: string, testExit: string) =>
    `node -e ${q(TRIAL_SUMMARY)} ${stage} "$HEAD_SHA" ${q(trial.package)} "$INSTALL" "${testExit}" "$(( T1 - T0 ))" "$(( T2 - T1 ))" "$(git -c core.fileMode=false diff --name-only)"`;
  return [
    PREAMBLE,
    `cd repo 2>/dev/null || { echo "there is no checkout in the workspace to try it on"; exit 90; }`,
    `HEAD_SHA=$(git rev-parse HEAD)`,
    `T0=$(date +%s)`,
    `npm install --no-audit --no-fund ${saveFlags(trial.section, trial.spec)} ${q(`${trial.package}@${trial.version}`)} > "$W/.steward/install.log" 2>&1; INSTALL=$?`,
    `T1=$(date +%s); T2=$T1`,
    `if [ "$INSTALL" -ne 0 ]; then tail -n ${OUTPUT_LINES} "$W/.steward/install.log"; ${summary("install", "")}; exit 91; fi`,
    `( ${test} ) > "$W/.steward/test.log" 2>&1; TEST=$?`,
    `T2=$(date +%s)`,
    `tail -n ${OUTPUT_LINES} "$W/.steward/test.log"`,
    summary("test", "$TEST"),
    `exit "$TEST"`,
  ].join("\n");
}

// ---- Small helpers -----------------------------------------------------------------------------------

function parseJson(text: string | undefined | null): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** An exec effect's result. One too large for its event is in the evidence, and the event points at it. */
async function execResult(t: Turn): Promise<ExecResult | null> {
  const result = (t.event.body as EffectResult<ExecResult & { tooLarge?: boolean; body?: string }> | undefined)?.result;
  if (!result) return null;
  if (result.tooLarge && typeof result.body === "string") return parseJson(await t.readEvidence(result.body)) as ExecResult | null;
  return result;
}

/** The summary a command ended its output with, or null when it never got that far. */
function summaryOf<S extends { kind: string }>(result: ExecResult | null, kind: S["kind"]): S | null {
  const lines = String(result?.stdout ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.startsWith(`${MARK} `)) continue;
    const parsed = parseJson(lines[i]!.slice(MARK.length + 1)) as S | null;
    return parsed && parsed.kind === kind ? parsed : null;
  }
  return null;
}

/** Terminal control sequences, which test runners print even into a file. */
const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|\r/g;

/** The end of a command's output, without the summary line or terminal control sequences. */
function tail(result: ExecResult | null, lines = OUTPUT_LINES): string {
  const clean = (text: unknown) => String(text ?? "").replace(CONTROL, "");
  const text = clean(result?.stdout).split("\n").filter((line) => !line.startsWith(`${MARK} `)).join("\n").trim() || clean(result?.stderr).trim();
  return text.split("\n").slice(-lines).join("\n");
}

/** The last lines of an output, for a notice. */
const quoted = (output: string) => output.split("\n").slice(-QUOTED_LINES).join("\n");

type Reading = { ok: true; version: string } | { ok: false; error: string };

/** What npm's answer says the latest version is, or why it says nothing. */
function readLatest(body: EffectResult<HttpResult> | undefined): Reading {
  if (!body?.ok) {
    if (body?.inDoubt) return { ok: false, error: "no answer arrived" };
    return { ok: false, error: body?.error ? String(body.error) : "the request failed" };
  }
  const status = body.result?.status;
  if (typeof status === "number" && (status < 200 || status > 299)) return { ok: false, error: `HTTP ${status}` };
  const doc = body.result?.json ?? parseJson(body.result?.text);
  const version = (doc as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || !VERSION_TEXT.test(version)) return { ok: false, error: "the answer has no version in it" };
  return { ok: true, version };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Paragraphs of a notice, leaving out the ones there is nothing to say in. */
const paragraphs = (...parts: (string | null)[]) => parts.filter((part) => part !== null && part !== "").join("\n\n");
const clip = (text: string, max = 300) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const short = (sha: string | null) => (sha ?? "").slice(0, 7) || "an unknown commit";
/** Code-unit order, the same on every machine. */
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function checkNpm(t: Turn, w: WatchFile): void {
  t.effect("npm.get", { url: latestUrl(w.name), pick: ["name", "version"] }, { then: "watch.fetched" });
  t.wait({ for: "watch.fetched", reason: `npm's answer about ${w.name}` });
}

function sync(t: Turn, repo: RepoFile): void {
  t.effect("repo.sync", { command: syncCommand(repo, repo.baseline?.head ?? null) }, { then: "repo.synced" });
  t.wait({ for: "repo.synced", reason: `the checkout of ${repo.github} to come up to date` });
}

/** Why a trial can't run yet, or null when it can: the checkout must be there and its own tests must pass. */
function holdReason(repo: RepoFile | null): string | null {
  if (!repo?.head) return "there is no checkout to try it on yet";
  if (repo.baseline?.head !== repo.head) return `the repository's own tests haven't run at ${short(repo.head)} yet`;
  if (!repo.baseline.passed) return `the repository's own tests fail at ${short(repo.head)} without any upgrade`;
  return null;
}

/** Start the trial if the checkout is ready for one; otherwise hold it until the repository says so. */
function runOrHold(t: Turn, trial: TrialFile, repo: RepoFile | null): void {
  const held = holdReason(repo);
  if (held || !repo) {
    t.write("trial.json", { ...trial, state: "held", detail: held } satisfies TrialFile);
    t.wait({ for: "trial.retry", reason: `${held}, so ${trial.package} ${trial.version} waits` });
    return t.note(`Held ${trial.package} ${trial.version}: ${held}`);
  }
  t.write("trial.json", { ...trial, state: "running", detail: null, head: repo.head } satisfies TrialFile);
  t.effect("trial.run", { command: trialCommand(trial, repo.test) }, { then: "trial.ran" });
  t.wait({ for: "trial.ran", reason: `${trial.package} ${trial.version} to be installed and tested on a branch` });
  t.note(`Trying ${trial.package} ${trial.version} (${trial.reason}) against ${repo.github} at ${short(repo.head)}`);
}

// ---- The system ----------------------------------------------------------------------------------------

export default defineSystem({
  name: "upgrade-steward",
  charter,
  parts: {
    repo: {
      purpose: "Keep a checkout of my repository up to date, with its dependencies installed and its own tests run",
      schedules: [{ every: "6h", send: "repo.sync" }],
      on: {
        "repo.track": async (t) => {
          const { url, ref, test } = t.event.body ?? {};
          const github = typeof url === "string" ? (REPO_URL.exec(url)?.[1] ?? null) : null;
          if (!github) {
            t.tell(`I didn't start keeping ${JSON.stringify(url ?? null)}: I can clone a public repository on GitHub, named as https://github.com/<owner>/<name>. Send repo.track with {"url": "..."}.`);
            return;
          }
          if (ref !== undefined && (typeof ref !== "string" || !REF.test(ref))) return t.tell(`I didn't start keeping ${github}: ${JSON.stringify(ref)} isn't a branch or tag name.`);
          if (test !== undefined && (typeof test !== "string" || test.trim() === "" || test.length > 200 || /[\r\n]/.test(test))) {
            return t.tell(`I didn't start keeping ${github}: the test command has to be one line of at most 200 characters.`);
          }
          const current = await t.json<RepoFile>("repo.json");
          if (current && current.github !== github) {
            t.tell(`I already keep ${current.github}, so I didn't switch to ${github}. Give ${github} an atoll of its own.`);
            return;
          }
          const repo: RepoFile = {
            url: `https://github.com/${github}`,
            github,
            ref: ref ?? null,
            test: test?.trim() ?? "npm test",
            since: current?.since ?? t.now.toISOString(),
            head: current?.head ?? null,
            syncedAt: current?.syncedAt ?? null,
            // A different test command makes the old reading of the tests meaningless.
            baseline: current && current.test === (test?.trim() ?? "npm test") ? current.baseline : null,
          };
          t.write("repo.json", repo);
          sync(t, repo);
          t.note(`${current ? "Updated how I keep" : "Started keeping"} ${github}${repo.ref ? ` at ${repo.ref}` : ""}; tests run with \`${repo.test}\``);
        },

        "repo.sync": async (t) => {
          const repo = await t.json<RepoFile>("repo.json");
          if (!repo) return t.note('Nothing to sync yet: send repo repo.track with {"url": "https://github.com/<owner>/<name>"}');
          sync(t, repo);
        },

        "repo.synced": async (t) => {
          const repo = await t.json<RepoFile>("repo.json");
          if (!repo) return t.note("A sync finished for a repository I don't keep");
          const now = t.now.toISOString();
          const evidence = t.event.evidence ?? [];
          const body = t.event.body as EffectResult<ExecResult> | undefined;
          const result = await execResult(t);
          const summary = summaryOf<SyncSummary>(result, "sync");
          const health = await t.json<HealthFile>("health.json");

          if (!body?.ok || summary?.stage !== "done" || !summary.head) {
            const stage = summary?.stage === "git" ? "reach the repository" : summary?.stage === "install" ? "install its dependencies" : "finish";
            const error = clip(tail(result, 6) || String(body?.error ?? "no output"), 600);
            const failures = (health?.failures ?? 0) + 1;
            t.write("health.json", { failures, since: health?.since ?? now, lastAt: now, lastError: error, evidence } satisfies HealthFile);
            // A repository that can't be cloned is usually a wrong name, so the first failure is worth saying.
            if (failures === 1) t.tell(paragraphs(`I couldn't ${stage} for ${repo.github}:`, error, "The checkout is as it was. I'll try again at the next sync."), { evidence });
            return t.note(`Sync of ${repo.github} failed (couldn't ${stage}): ${plural(failures, "failed sync")} in a row`);
          }

          const notes: string[] = [];
          if (health) {
            t.delete("health.json");
            t.tell(`I can sync ${repo.github} again, after ${plural(health.failures, "failed sync")}.`, { evidence });
          }
          let baseline = repo.baseline;
          if (summary.test !== "skipped") {
            baseline = { head: summary.head, passed: summary.test === "0", at: now, seconds: summary.seconds ?? 0, evidence };
            notes.push(`its own tests ${baseline.passed ? "pass" : "fail"} at ${short(summary.head)} (${baseline.seconds} s)`);
          }
          const was = repo.baseline?.passed ?? null;
          if (baseline?.passed === false && was !== false) {
            t.tell(paragraphs(`${repo.github}'s own tests fail at ${short(summary.head)}, before any upgrade. I'm holding every trial until they pass. The last lines:`, quoted(tail(result))), { evidence });
          }
          if (baseline?.passed === true && was === false) t.tell(`${repo.github}'s own tests pass again at ${short(summary.head)}. Trials can run.`, { evidence });
          t.write("repo.json", { ...repo, head: summary.head, syncedAt: now, baseline } satisfies RepoFile);

          // Tell each watch what the repository has now, but only the ones for which that changed.
          const before = new Map(((await t.json<Dep[]>("deps.json")) ?? []).map((d) => [d.name, d]));
          const deps = (summary.deps ?? []).map(asDep).filter((d): d is Dep => d !== null).sort(byName);
          t.write("deps.json", deps);
          let told = 0;
          for (const dep of deps.filter(watchable)) {
            const old = before.get(dep.name);
            before.delete(dep.name);
            if (old && watchable(old) && JSON.stringify(old) === JSON.stringify(dep)) continue;
            t.send(watchAddress(dep.name), "watch.set", dep);
            told += 1;
          }
          const dropped = [...before.values()].filter(watchable);
          for (const dep of dropped) t.send(watchAddress(dep.name), "watch.drop", { name: dep.name });
          if (told || dropped.length) notes.push(`${plural(told, "watch", "watches")} updated, ${dropped.length} dropped`);

          // Trials wait on the tests passing here. When they first do, or do again, let the held ones go.
          if (baseline?.passed === true && baseline.head === summary.head && was !== true) {
            let released = 0;
            for (const path of await t.list("/parts/trial")) {
              if (!path.endsWith("/trial.json")) continue;
              const trial = await t.json<TrialFile>(`/parts/trial/${path}`);
              if (trial?.state !== "held") continue;
              t.send(`trial/${path.slice(0, -"/trial.json".length)}`, "trial.retry", {});
              released += 1;
            }
            if (released) notes.push(`released ${plural(released, "held trial")}`);
          }
          t.note(`Synced ${repo.github} to ${short(summary.head)}${summary.install === "skipped" ? "" : "; installed its dependencies"}${notes.length ? `; ${notes.join("; ")}` : ""}`);
        },
      },
    },

    watch: {
      purpose: "Send each new version of this dependency to a trial",
      instances: true,
      schedules: [{ every: "6h", send: "watch.poll" }],
      on: {
        "watch.set": async (t) => {
          const dep = asDep(t.event.body);
          if (!dep || t.self !== watchAddress(dep.name)) return t.note(`Ignored a watch.set that isn't for ${t.self}: ${clip(JSON.stringify(t.event.body ?? null))}`);
          const current = await t.json<WatchFile>("watch.json");
          if (current && current.name !== dep.name) {
            t.tell(`${t.self} already watches ${current.name}, and ${dep.name} maps to the same name. I'm not watching ${dep.name}.`);
            return;
          }
          const w: WatchFile = { ...dep, since: current?.since ?? t.now.toISOString() };
          t.write("watch.json", w);
          // The repository's version moved, so what npm calls latest is judged against it afresh.
          checkNpm(t, w);
          t.note(current ? `${dep.name} is now at ${dep.installed} in the repository (it was ${current.installed})` : `Started watching ${dep.name}, which the repository has at ${dep.installed}`);
        },

        "watch.drop": async (t) => {
          const w = await t.json<WatchFile>("watch.json");
          t.done(`${w?.name ?? "it"} is no longer a dependency of the repository`);
        },

        "watch.poll": async (t) => {
          const w = await t.json<WatchFile>("watch.json");
          if (!w) return t.note("Nothing to check yet: the repository hasn't told this watch what it follows");
          checkNpm(t, w);
        },

        "watch.fetched": async (t) => {
          const w = await t.json<WatchFile>("watch.json");
          if (!w) return t.note("npm answered for a watch that isn't watching anything");
          const now = t.now.toISOString();
          const evidence = t.event.evidence ?? [];
          const reading = readLatest(t.event.body);
          const health = await t.json<HealthFile>("health.json");

          if (!reading.ok) {
            const failures = (health?.failures ?? 0) + 1;
            t.write("health.json", { failures, since: health?.since ?? now, lastAt: now, lastError: reading.error, evidence } satisfies HealthFile);
            if (failures === FAILURES_BEFORE_TELLING) {
              t.tell(`I couldn't read ${w.name} from npm the last ${failures} times I checked, most recently: ${reading.error}. I'll keep checking every six hours.`, { evidence });
            }
            return t.note(`Couldn't read ${w.name} from npm (${reading.error}): ${plural(failures, "failed check")} in a row`);
          }
          if (health) {
            t.delete("health.json");
            if (health.failures >= FAILURES_BEFORE_TELLING) t.tell(`I can read ${w.name} from npm again, after ${health.failures} failed checks.`, { evidence });
          }

          const verdict = classify(reading.version, w.installed);
          const latest = await t.json<LatestFile>("latest.json");
          const trial = verdict.upgrade ? trialAddress(w.name, reading.version) : null;
          if (latest?.version === reading.version && latest.trial === trial) return;
          t.write("latest.json", { version: reading.version, seenAt: now, trial, evidence } satisfies LatestFile);
          if (!trial) return t.note(`npm's latest ${w.name} is ${reading.version}: ${verdict.reason}`);
          t.send(trial, "trial.start", { package: w.name, version: reading.version, from: w.installed, section: w.section, spec: w.spec }, { evidence });
          t.note(`npm's latest ${w.name} is ${reading.version}, ${verdict.reason}; sent it to ${trial}`);
        },
      },
    },

    trial: {
      purpose: "Try one new version of one dependency on a copy of the checkout, and tell me whether the tests still pass",
      instances: true,
      on: {
        "trial.start": async (t) => {
          const body = t.event.body ?? {};
          const { package: name, version } = body;
          if (!isPackageName(name) || typeof version !== "string" || !VERSION_TEXT.test(version)) {
            return t.note(`Ignored a trial.start without a package name and version: ${clip(JSON.stringify(body))}`);
          }
          // One instance per package and version is what makes a second report of a release harmless.
          const address = trialAddress(name, version);
          if (t.self !== address) {
            t.tell(`${t.self} isn't where ${name} ${version} is tried. Send trial.start to ${address}.`);
            return;
          }
          const existing = await t.json<TrialFile>("trial.json");
          if (existing && existing.state !== "held") return t.note(`Already tried ${name} ${version} (${existing.state}); send trial.retry with {"again": true} to try it again`);

          // A trial I ask for by hand names only the package and version; the repository knows the rest.
          const deps = (await t.json<Dep[]>("/parts/repo/deps.json")) ?? [];
          const dep = asDep({ name, section: body.section, spec: body.spec, installed: body.from }) ?? deps.find((d) => d.name === name) ?? null;
          if (!dep) {
            t.tell(`I didn't try ${name} ${version}: ${name} isn't a dependency of the repository I keep.`);
            return;
          }
          const verdict = classify(version, dep.installed);
          const trial: TrialFile = {
            package: name,
            version,
            from: dep.installed,
            section: dep.section,
            spec: dep.spec,
            ...verdict,
            state: "held",
            detail: null,
            head: null,
            requestedAt: existing?.requestedAt ?? t.now.toISOString(),
            finishedAt: null,
            branch: null,
            checkpoint: null,
            seconds: null,
            changed: [],
            evidence: t.event.evidence ?? [],
            pull: null,
          };
          runOrHold(t, trial, await t.json<RepoFile>("/parts/repo/repo.json"));
        },

        "trial.retry": async (t) => {
          const trial = await t.json<TrialFile>("trial.json");
          if (!trial) return t.note("Nothing to retry: this trial was never started");
          const again = t.event.body?.again === true;
          if (trial.state === "running") return t.note(`${trial.package} ${trial.version} is already being tried`);
          if (trial.state !== "held" && trial.state !== "errored" && !again) {
            return t.note(`${trial.package} ${trial.version} was already tried (${trial.state}); send trial.retry with {"again": true} to try it again`);
          }
          runOrHold(t, { ...trial, finishedAt: null, branch: null, checkpoint: null, seconds: null, changed: [], pull: null }, await t.json<RepoFile>("/parts/repo/repo.json"));
        },

        "trial.ran": async (t) => {
          const trial = await t.json<TrialFile>("trial.json");
          if (!trial) return t.note("A trial finished that this instance never started");
          const repo = await t.json<RepoFile>("/parts/repo/repo.json");
          const body = t.event.body as EffectResult<ExecResult> | undefined;
          const result = await execResult(t);
          const summary = summaryOf<TrialSummary>(result, "trial");
          const evidence = [...new Set([...trial.evidence, ...(t.event.evidence ?? [])])].sort();
          const where = `${repo?.github ?? "the repository"} at ${short(summary?.head ?? trial.head)}`;
          const what = `${trial.package} ${trial.version}`;
          const output = tail(result);
          const done: TrialFile = {
            ...trial,
            head: summary?.head ?? trial.head,
            finishedAt: t.now.toISOString(),
            branch: result?.branch ?? null,
            checkpoint: result?.checkpoint ?? null,
            seconds: summary ? { install: summary.installSeconds, test: summary.testSeconds } : null,
            changed: summary?.changed ?? [],
            evidence,
          };
          const kept = done.branch ? `The checkout it left is on branch ${done.branch}.` : null;
          if (output) t.write("output.txt", `${output}\n`);

          // No summary means the command never reported: the microVM timed out, or the disk couldn't be branched.
          if (!summary) {
            const detail = clip(String(body?.error ?? "the command ended without a result"), 400);
            t.write("trial.json", { ...done, state: "errored", detail } satisfies TrialFile);
            t.tell(`I couldn't try ${what} on ${where}: ${detail}. Send ${t.self} trial.retry to try again.`, { evidence });
            return t.done(`the trial of ${what} didn't run`);
          }
          if (summary.stage === "install" || summary.install !== 0) {
            t.write("trial.json", { ...done, state: "not-installable", detail: "npm couldn't install it" } satisfies TrialFile);
            t.tell(paragraphs(`I couldn't install ${what} into ${where}, so its tests never ran. The last lines:`, quoted(output), kept), { evidence });
            return t.done(`${what} couldn't be installed`);
          }
          if (!body?.ok || summary.test !== 0) {
            t.write("trial.json", { ...done, state: "failed", detail: `the tests exited ${summary.test}` } satisfies TrialFile);
            t.tell(paragraphs(`${what} breaks ${where}: the tests pass without it and fail with it. It is ${trial.reason}. The last lines:`, quoted(output), kept), { evidence });
            return t.done(`${what} fails the tests`);
          }

          const passed: TrialFile = { ...done, state: "passed", detail: null };
          t.tell(paragraphs(`${what} is safe for ${where}: the tests pass with it (${summary.testSeconds} s). It is ${trial.reason}, and it changes ${done.changed.join(" and ") || "no tracked file"}.`, kept), { evidence });
          if (!repo) {
            t.write("trial.json", passed);
            return t.done(`${what} passes the tests`);
          }
          const args: PullArgs = {
            repo: repo.github,
            package: trial.package,
            version: trial.version,
            from: trial.from,
            section: trial.section,
            save: saveFlags(trial.section, trial.spec),
            head: done.head ?? "",
            trial: t.self,
            branch: done.branch,
            evidence,
          };
          t.effect("pr.open", args, { then: "pr.done" });
          t.write("trial.json", { ...passed, pull: { state: "asked", at: t.now.toISOString(), detail: null } } satisfies TrialFile);
          t.wait({ for: "pr.done", reason: `your answer about a pull request for ${what}, and then GitHub's` });
        },

        "pr.done": async (t) => {
          const trial = await t.json<TrialFile>("trial.json");
          if (!trial) return t.note("A pull request was answered for a trial this instance never ran");
          const body = t.event.body as EffectResult<{ requested?: boolean; reason?: string; status?: number }> | undefined;
          const what = `${trial.package} ${trial.version}`;
          const at = t.now.toISOString();
          const byHand = `To make the change yourself: npm install ${saveFlags(trial.section, trial.spec)} ${trial.package}@${trial.version}`;
          const settle = (state: NonNullable<TrialFile["pull"]>["state"], detail: string | null) => t.write("trial.json", { ...trial, pull: { state, at, detail } } satisfies TrialFile);

          if (body?.denied) {
            settle("declined", null);
            return t.done(`${what} passes the tests; you declined a pull request`);
          }
          if (body?.ok && body.result?.requested) {
            settle("requested", null);
            t.tell(`I asked GitHub to open the pull request for ${what}. The repository's atoll-upgrade workflow makes the change and opens it.`);
            return t.done(`${what} passes the tests; a pull request was requested`);
          }
          const reason = clip(String(body?.result?.reason ?? body?.error ?? "GitHub didn't accept the request"), 300);
          if (body?.inDoubt) {
            settle("unknown", reason);
            t.tell(`I don't know whether GitHub got the request for a pull request for ${what}: ${reason}. Look for it before asking again.`);
            return t.done(`${what} passes the tests; a pull request may or may not have been requested`);
          }
          settle("not-requested", reason);
          t.tell(`You approved a pull request for ${what}, but I couldn't ask GitHub for it: ${reason}. ${byHand}`);
          t.done(`${what} passes the tests; no pull request was requested`);
        },
      },
    },
  },

  effects: {
    "npm.get": {
      kind: "http",
      allow: ["registry.npmjs.org"],
      // One call per dependency every six hours: 40 dependencies use about 4,900 a month.
      budget: { calls: 10_000, per: "month" },
    },
    "repo.sync": {
      kind: "exec",
      scope: "workspace",
      ignore: IGNORED,
      // Fetching, resetting and installing again leaves the checkout where one run would.
      idempotent: true,
      // The hosts the command reaches. A microVM isn't held to them today; a door's sandbox would be.
      allow: ["github.com", "registry.npmjs.org"],
      budget: { calls: 400, per: "month" },
    },
    "trial.run": {
      kind: "exec",
      scope: "workspace",
      // On a branch of the whole disk, and never merged: the verdict comes back, and the checkout stays.
      fork: true,
      merge: false,
      ignore: IGNORED,
      // A trial interrupted halfway runs again on a fresh branch; nothing of the first one is in the way.
      idempotent: true,
      allow: ["registry.npmjs.org"],
      budget: { calls: 300, per: "month" },
    },
    "pr.open": {
      kind: "custom",
      approval: true,
      idempotent: false,
      allow: ["api.github.com"],
      describe: (args: PullArgs) =>
        `Ask GitHub to open a pull request on ${args?.repo} that upgrades ${args?.package} from ${args?.from ?? "its current version"} to ${args?.version}, whose tests passed on a copy at ${short(args?.head ?? null)}`,
      /**
       * Sends the repository a repository_dispatch event, which its atoll-upgrade workflow answers by
       * making the change and opening the pull request (see github/atoll-upgrade.yml). The token is the
       * runner's, from GITHUB_TOKEN; GitHub answers 204 and nothing else when it accepts the event.
       */
      run: async (args: PullArgs, ctx) => {
        const token = process.env.GITHUB_TOKEN;
        if (!token) return { requested: false, reason: "GITHUB_TOKEN isn't set where the steward runs" };
        const api = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
        let response: Response;
        try {
          response = await fetch(`${api}/repos/${args.repo}/dispatches`, {
            method: "POST",
            headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "atoll-upgrade-steward", "x-github-api-version": "2022-11-28" },
            body: JSON.stringify({
              event_type: "atoll-upgrade",
              // GitHub allows ten top-level properties here.
              client_payload: { package: args.package, version: args.version, from: args.from, save: args.save, head: args.head, trial: args.trial, branch: args.branch, evidence: args.evidence.join(" "), key: ctx.key },
            }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (error) {
          // A request that never connected certainly wasn't received; one that went quiet may have been.
          const code = (error as { cause?: { code?: string } }).cause?.code;
          if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") return { requested: false, reason: "GitHub couldn't be reached" };
          return { requested: false, inDoubt: true, reason: "GitHub didn't confirm it" };
        }
        if (response.status === 204) return { requested: true, repo: args.repo, event: "atoll-upgrade" };
        const said = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
        const hint = response.status === 404 ? " (the token can't see that repository, or it doesn't exist)" : response.status === 401 || response.status === 403 ? " (the token isn't allowed to; it needs write access to the repository's contents)" : "";
        return { requested: false, status: response.status, reason: `GitHub answered ${response.status}${hint}${said ? `: ${said}` : ""}` };
      },
    },
  },
});
