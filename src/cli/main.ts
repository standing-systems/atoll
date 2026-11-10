// The atoll CLI. Every command takes --dir <path> (a local atoll) or --disk <name|id> (an Archil disk),
// and --json. Exit codes: 0 ok, 1 a check failed, 2 usage, 3 not in an atoll project.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, type JournalRecord, type Manifest } from "../format.ts";
import { asText, hasSnapshots, type Store } from "../store/types.ts";
import { answer, deliver, tick, withRunner } from "../runtime/runner.ts";
import { createAtoll, push, atollInfo } from "../runtime/atoll.ts";
import { fiveAnswers, openAsks, renderAnswers, why } from "../runtime/status.ts";
import { checkAtoll, checkSystem } from "../runtime/check.ts";
import { replay, type ReplayReport } from "../runtime/replay.ts";
import { bundleSystem, currentCodeVersion, loadCurrentSystem, loadProjectSystem, loadSystemVersion } from "../runtime/code.ts";
import { readJournal } from "../runtime/journal.ts";
import { readJson } from "../runtime/install.ts";
import { keyRoutes, modelHost, modelNeeds, planModelKeys } from "../runtime/models.ts";
import { declaredHosts } from "../system.ts";
import { parseDuration } from "../ids.ts";
import { findProject, NotInProject, resolveTarget, UsageError, type Project, type Target } from "./target.ts";
import { loadDotEnv, type DotEnv } from "./dotenv.ts";
import { TEMPLATES } from "./templates.generated.ts";
import type { Problem, TickReport } from "../runtime/types.ts";

declare const __ATOLL_VERSION__: string | undefined;
const VERSION = typeof __ATOLL_VERSION__ === "string" ? __ATOLL_VERSION__ : "0.1.0-dev";
/** The package's name. It is not published yet; the bare name "atoll" on npm belongs to another project. */
const PACKAGE = "@standing-systems/atoll";

export interface CommandInfo {
  name: string;
  usage: string;
  summary: string;
}

export const COMMANDS: CommandInfo[] = [
  { name: "doctor", usage: "atoll doctor [--online]", summary: "Check Node, Archil credentials and region, and the project; offline unless --online; never prints a secret" },
  { name: "init", usage: "atoll init <dir> [--template blank|release-radar|promise-keeper|upgrade-steward]", summary: "Scaffold a project; never overwrites" },
  { name: "create", usage: "atoll create <name> [--disk <name|dsk-id>] [--prefix <folder>] [--charter <text>] [--alongside]", summary: "Create the Archil disk (or local directory) and lay out an empty atoll; where files already are, show the top level and stop unless --alongside" },
  { name: "push", usage: "atoll push [--entry system.ts] [--no-checkpoint] [--alongside]", summary: "Bundle system.ts, store it on the disk, make it current, checkpoint" },
  { name: "send", usage: "atoll send <to> <type> [json] [--tick]", summary: "Deliver an event" },
  { name: "tick", usage: "atoll tick [--max <n>] [--checkpoint]", summary: "Run turns until the inbox is empty" },
  { name: "status", usage: "atoll status [address] [--json]", summary: "The five answers: purpose, changes, waits, evidence, and what it needs from you" },
  { name: "why", usage: "atoll why <path|event-id|seq|fx-id|ask-id>", summary: "The turn that produced something, and its causes back to the first" },
  { name: "log", usage: "atoll log [--since <duration>] [--part <address>]", summary: "Turns and effect outcomes, oldest first" },
  { name: "asks", usage: "atoll asks", summary: "Questions waiting for you" },
  { name: "answer", usage: "atoll answer <ask-id> <option> [--payload <json>] [--no-tick]", summary: "Answer a question, then tick" },
  { name: "check", usage: "atoll check [--entry system.ts]", summary: "The declaration, the six promises, idle parts, files changed outside a turn" },
  { name: "replay", usage: "atoll replay [--code <file>]", summary: "Re-handle every recorded turn through the code version that recorded it (or one version with --code); they must match" },
  { name: "try", usage: "atoll try [--entry system.ts]", summary: "Re-handle recorded turns through the working copy's code and show what would differ" },
  { name: "fork", usage: "atoll fork [--checkpoint <name>] [--name <branch>]", summary: "Branch the disk: a full, independent copy of the atoll" },
  { name: "checkpoint", usage: "atoll checkpoint <name>", summary: "Checkpoint the whole disk" },
  { name: "door", usage: "atoll door up|down|url|token|call", summary: "A sandbox that sleeps until a request wakes it, running atoll serve from the disk" },
  { name: "clock", usage: "atoll clock [--cron <expr>] [--crontab|--launchd|--github|--door] [--write <path>]", summary: "Configuration for something outside to call tick on time" },
  { name: "serve", usage: "atoll serve [--port 8080] [--host 127.0.0.1]", summary: "The door's HTTP server: POST /events, POST /tick, GET /status" },
  { name: "ls", usage: "atoll ls [prefix]", summary: "List an atoll's files, even on a disk you can't mount" },
  { name: "cat", usage: "atoll cat <path>", summary: "Print an atoll file" },
  { name: "hook", usage: "atoll hook check-on-edit", summary: "For the Claude Code plugin: report hard check errors after an edit" },
  { name: "help", usage: "atoll help [--json]", summary: "This list" },
  { name: "version", usage: "atoll version", summary: "The CLI's version" },
];

// ---- arguments ------------------------------------------------------------------------------------

interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(["json", "tick", "no-tick", "checkpoint", "no-checkpoint", "crontab", "launchd", "github", "door", "show", "yes", "help", "online", "alongside"]);

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (inline !== undefined) flags[name] = inline;
      else if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) throw new UsageError(`--${name} needs a value`);
        flags[name] = next;
        i++;
      }
    } else positional.push(arg);
  }
  return { positional, flags };
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

// ---- output ---------------------------------------------------------------------------------------

class Output {
  readonly json: boolean;
  readonly lines: string[] = [];
  constructor(json: boolean) {
    this.json = json;
  }
  line(text = ""): void {
    if (!this.json) process.stdout.write(`${text}\n`);
  }
  data(command: string, value: unknown): void {
    if (this.json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command, atollVersion: VERSION, ...((value as object) ?? {}) }, null, 2)}\n`);
  }
}

function summarizeReport(report: TickReport): string {
  if (!report.ran) return `Another runner holds the lease (${report.heldBy}); nothing ran.`;
  const parts = [`${report.turns} turn${report.turns === 1 ? "" : "s"}`];
  if (report.failures) parts.push(`${report.failures} failed`);
  if (report.duplicates) parts.push(`${report.duplicates} duplicate${report.duplicates === 1 ? "" : "s"} skipped`);
  if (report.timersFired) parts.push(`${report.timersFired} timer${report.timersFired === 1 ? "" : "s"} fired`);
  if (report.answersApplied) parts.push(`${report.answersApplied} answer${report.answersApplied === 1 ? "" : "s"} applied`);
  const e = report.effects;
  const fx = [e.done && `${e.done} done`, e.failed && `${e.failed} failed`, e.inDoubt && `${e.inDoubt} in doubt`, e.awaitingApproval && `${e.awaitingApproval} awaiting approval`, e.overBudget && `${e.overBudget} over budget`].filter(Boolean);
  if (fx.length) parts.push(`effects: ${fx.join(", ")}`);
  if (report.recovered.reinstalled || report.recovered.inDoubt) parts.push(`recovered ${report.recovered.reinstalled} record(s)`);
  if (report.remaining) parts.push(`${report.remaining} event(s) left for the next tick`);
  return `Tick at epoch ${report.epoch}: ${parts.join("; ")}. ${report.nextWake ? `Next timer due ${report.nextWake}.` : "No timers set."}`;
}

function printProblems(out: Output, problems: Problem[]): void {
  for (const p of problems) out.line(`${p.severity === "error" ? "error  " : "warning"} ${p.code} at ${p.where}: ${p.message}`);
}

// ---- commands -------------------------------------------------------------------------------------

interface Ctx {
  args: Parsed;
  out: Output;
  project: Project | null;
  /** The project's .env, when it has one: which credentials it supplied, never their values. */
  dotenv: DotEnv | null;
}

async function target(ctx: Ctx, name?: string): Promise<Target> {
  return resolveTarget({ ...(str(ctx.args.flags.dir) ? { dir: str(ctx.args.flags.dir)! } : {}), ...(str(ctx.args.flags.disk) ? { disk: str(ctx.args.flags.disk)! } : {}), ...(str(ctx.args.flags.mounted) ? { mounted: str(ctx.args.flags.mounted)! } : {}), ...(str(ctx.args.flags.prefix) ? { prefix: str(ctx.args.flags.prefix)! } : {}) }, ctx.project, name);
}

/** What an atoll adds at its root (see paths in src/format.ts). */
const LAYOUT = [".atoll/", "CHARTER.md", "STATUS.md", "atoll.json", "inbox/", "journal/", "parts/", "asks/", "outbox/", "notices/", "evidence/", "workspace/"];

/**
 * Before laying an atoll out where there isn't one, look at what is already there. Archil's own setup
 * prompts never create folders on a disk that already has files without first showing its top level.
 * Atoll never overwrites a file either way; this makes putting its files beside someone else's a choice.
 */
async function clearToLayOut(ctx: Ctx, command: string, store: Store, describe: string, elsewhere: string): Promise<boolean> {
  if (ctx.args.flags.alongside || !store.listTop || (await atollInfo(store)).exists) return true;
  const top = await store.listTop();
  if (top.length === 0) return true;
  const shared = LAYOUT.filter((name) => top.includes(name));
  ctx.out.data(command, { refused: "existing-files", location: store.location, top, alreadyThere: shared });
  ctx.out.line(`${describe} already has files, and it isn't an atoll. Its top level:`);
  for (const name of top.slice(0, 25)) ctx.out.line(`  ${name}`);
  if (top.length > 25) ctx.out.line(`  and ${top.length - 25} more`);
  ctx.out.line(`atoll never overwrites a file, but it would add ${LAYOUT.join(" ")} beside them.`);
  if (shared.length) ctx.out.line(`Already here: ${shared.join(" ")}. Atoll would use ${shared.length === 1 ? "it" : "them"} as its own, keeping every file in ${shared.length === 1 ? "it" : "them"}.`);
  ctx.out.line(`To go ahead, run it again with --alongside. ${elsewhere}`);
  return false;
}

function elsewhereHint(t: Target): string {
  if (t.kind === "archil") return "Or keep the atoll in a folder of its own with --prefix <folder>.";
  if (t.kind === "mount") return "Or mount a disk that's empty.";
  return "Or point --dir at an empty directory.";
}

/** A path as a person would type it from here. */
function shownPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") ? rel : path;
}

/** Whether git ignores the file; null outside a repository or without git. */
function gitIgnores(path: string): boolean | null {
  const result = spawnSync("git", ["check-ignore", "-q", basename(path)], { cwd: dirname(path), stdio: "ignore" });
  if (result.error) return null;
  return result.status === 0 ? true : result.status === 1 ? false : null;
}

async function requireAtoll(t: Target): Promise<void> {
  if (!(await atollInfo(t.store)).exists) throw new NotInProject(`${t.describe} isn't an atoll yet (no .atoll/format). Run \`atoll create\` or \`atoll push\` first.`);
}

/** "a", "a and b", "a, b and c". */
function andList(items: string[]): string {
  return items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The keys the project's code calls its models with, for a clock that runs it somewhere else. */
async function projectModelKeys(ctx: Ctx): Promise<{ keys: string[]; error?: string }> {
  if (!ctx.project && !str(ctx.args.flags.entry)) return { keys: [] };
  try {
    const { system } = await loadProjectSystem(entryOf(ctx));
    return { keys: [...new Set(modelNeeds(system).map((need) => need.key))] };
  } catch (error) {
    return { keys: [], error: (error as Error).message.split("\n")[0] };
  }
}

function entryOf(ctx: Ctx): string {
  const entry = str(ctx.args.flags.entry);
  if (entry) return resolve(entry);
  if (ctx.project) return ctx.project.entry;
  throw new NotInProject();
}

async function ownBundle(): Promise<Uint8Array | undefined> {
  const self = fileURLToPath(import.meta.url);
  if (!self.endsWith(".mjs")) return undefined;
  return new Uint8Array(await readFile(self));
}

const commands: Record<string, (ctx: Ctx) => Promise<number>> = {
  async help(ctx) {
    if (ctx.out.json) ctx.out.data("help", { commands: COMMANDS });
    else {
      ctx.out.line(`atoll ${VERSION}: standing agents that live on Archil disks`);
      ctx.out.line();
      for (const c of COMMANDS) ctx.out.line(`  ${c.usage.padEnd(70)} ${c.summary}`);
      ctx.out.line();
      ctx.out.line("Every command takes --dir <path> for a local atoll or --disk <name|id> for an Archil disk, and --json.");
    }
    return 0;
  },

  async version(ctx) {
    ctx.out.data("version", { version: VERSION });
    ctx.out.line(VERSION);
    return 0;
  },

  async doctor(ctx) {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
    checks.push({ name: "node", ok: major > 22 || (major === 22 && minor >= 19), detail: `Node ${process.versions.node} (needs 22.19 or later)` });
    const from = (name: string) => (ctx.dotenv?.loaded.includes(name) ? ` from ${shownPath(ctx.dotenv.path)}` : "");
    const looked = ctx.dotenv ? ` in the environment or ${shownPath(ctx.dotenv.path)}` : " in the environment or a .env file here";
    const key = process.env.ARCHIL_API_KEY;
    checks.push({ name: "archil-key", ok: Boolean(key), detail: key ? `ARCHIL_API_KEY is set${from("ARCHIL_API_KEY")} (${key.startsWith("key-") ? "looks like an Archil key" : "doesn't start with key-"}; not shown)` : `ARCHIL_API_KEY is not set${looked}: local atolls work, Archil disks don't` });
    const region = process.env.ARCHIL_REGION;
    const computeRegions = ["aws-us-east-1", "aws-us-west-2", "aws-eu-west-1"];
    checks.push({ name: "archil-region", ok: Boolean(region), detail: region ? `ARCHIL_REGION is ${region}${from("ARCHIL_REGION")}${computeRegions.includes(region) ? " (exec and sandboxes run here)" : " (storage only: no exec, sandboxes, or doors)"}` : `ARCHIL_REGION is not set${looked}: use the region your API key was created in, one of ${[...computeRegions, "gcp-us-central1"].join(", ")} (exec, sandboxes, and doors need an AWS one)` });
    if (key && region && ctx.args.flags.online) {
      try {
        const { Archil } = await import("disk");
        const disks = await new Archil({ apiKey: key, region }).disks.list();
        checks.push({ name: "archil-api", ok: true, detail: `Archil answered: ${disks.length} disk${disks.length === 1 ? "" : "s"} in ${region}` });
      } catch (error) {
        checks.push({ name: "archil-api", ok: false, detail: `Archil refused: ${(error as Error).message}. A key works only in the region it was created in.` });
      }
    }
    if (key && region && !ctx.args.flags.online) checks.push({ name: "archil-api", ok: true, detail: "Not contacting Archil (pass --online to check the key against the API with one read-only call)" });
    checks.push({ name: "models", ok: true, detail: `Model keys: ANTHROPIC_API_KEY ${process.env.ANTHROPIC_API_KEY ? `set${from("ANTHROPIC_API_KEY")}` : "not set"}, OPENAI_API_KEY ${process.env.OPENAI_API_KEY ? `set${from("OPENAI_API_KEY")}` : "not set"} (without its key, a model effect answers with its stand-in, or fails if it has none)` });
    if (ctx.dotenv) {
      const shown = shownPath(ctx.dotenv.path);
      const supplied = ctx.dotenv.loaded.length ? `supplied ${ctx.dotenv.loaded.join(", ")}` : "supplied nothing the environment didn't already set";
      const ignored = ctx.dotenv.error ? null : gitIgnores(ctx.dotenv.path);
      checks.push({
        name: "env-file",
        ok: !ctx.dotenv.error && ignored !== false,
        detail: ctx.dotenv.error
          ? `${shown} couldn't be read (${ctx.dotenv.error})`
          : ignored === false
            ? `${shown} ${supplied}, but git doesn't ignore it: add .env to .gitignore so its keys are never committed`
            : `${shown} ${supplied} (values not shown)`,
      });
    }
    try {
      await import("esbuild");
      checks.push({ name: "esbuild", ok: true, detail: "esbuild is available for atoll push" });
    } catch {
      checks.push({ name: "esbuild", ok: false, detail: "esbuild is missing; atoll push needs it (run npm install in the project, or npm install --save-dev esbuild)" });
    }
    checks.push({ name: "project", ok: Boolean(ctx.project), detail: ctx.project ? `Project at ${ctx.project.root} (entry ${relative(ctx.project.root, ctx.project.entry)}${ctx.project.disk ? `, disk ${ctx.project.disk}` : ", local by default"})` : "Not in an atoll project (no system.ts here or above)" });
    ctx.out.data("doctor", { checks });
    for (const c of checks) ctx.out.line(`${c.ok ? "ok  " : "fix "} ${c.detail}`);
    return checks.every((c) => c.ok || c.name === "project") ? 0 : 1;
  },

  async init(ctx) {
    const dir = ctx.args.positional[0];
    if (!dir) throw new UsageError("atoll init <dir> [--template blank|release-radar|promise-keeper|upgrade-steward]");
    const template = str(ctx.args.flags.template) ?? "blank";
    const extra = template === "blank" ? {} : TEMPLATES[template];
    if (!extra || (template !== "blank" && Object.keys(extra).length === 0)) throw new UsageError(`No template "${template}"; use blank, release-radar, promise-keeper, or upgrade-steward`);
    // An example brings its own system, charter and tests; from the blank project it takes only the scaffolding.
    const scaffold = Object.fromEntries(Object.entries(TEMPLATES.project ?? {}).filter(([path]) => template === "blank" || !/^(system\.ts|CHARTER\.md|test\/)/.test(path)));
    const files = { ...scaffold, ...extra };
    const root = resolve(dir);
    const name = root.split("/").at(-1)!.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "my-atoll";
    const written: string[] = [];
    const skipped: string[] = [];
    // Atoll isn't on npm yet: a CLI run from a checkout points new projects at that checkout.
    const checkout = atollCheckout();
    const dependency = checkout ? `file:${checkout}` : `^${VERSION}`;
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path);
      if (existsSync(full)) {
        skipped.push(path);
        continue;
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content.replaceAll("__ATOLL_NAME__", name).replaceAll("__ATOLL_VERSION__", VERSION).replaceAll("__ATOLL_DEP__", dependency));
      written.push(path);
    }
    ctx.out.data("init", { dir: root, template, written, skipped });
    ctx.out.line(`Scaffolded ${written.length} file${written.length === 1 ? "" : "s"} in ${root}${skipped.length ? ` (kept ${skipped.length} that already existed)` : ""}.`);
    if (!checkout) {
      ctx.out.line(`${PACKAGE} isn't on npm yet, so npm install can't fetch it. Until it is, point that entry in package.json's devDependencies at a checkout of Atoll (file:/path/to/atoll).`);
    }
    ctx.out.line("Next: npm install, then npm test. `atoll tick` runs on a local atoll in .atoll-local/ until you set a disk.");
    return 0;
  },

  async create(ctx) {
    const name = ctx.args.positional[0] ?? ctx.project?.name;
    if (!name || !/^[a-z][a-z0-9-]{0,62}$/.test(name)) throw new UsageError("atoll create <name>: a name of lowercase letters, digits, and hyphens");
    const disk = str(ctx.args.flags.disk) ?? (str(ctx.args.flags.dir) ? undefined : ctx.project?.disk);
    if (disk || (!str(ctx.args.flags.dir) && process.env.ARCHIL_API_KEY && ctx.args.flags.archil !== undefined)) {
      const { Archil } = await import("disk");
      const archil = new Archil({ apiKey: process.env.ARCHIL_API_KEY, region: process.env.ARCHIL_REGION });
      const { ArchilStore } = await import("../store/archil.ts");
      // A disk ID names an existing disk (or branch): lay the atoll out on it. A name creates the disk,
      // or finds it if it already exists. Its one-time mount token is never printed or stored.
      const result = disk && /^dsk-/.test(disk) ? { disk: await archil.disks.get(disk) } : await archil.disks.create({ name: disk ?? name });
      const prefix = str(ctx.args.flags.prefix) ?? ctx.project?.prefix;
      const store = await ArchilStore.open({ disk: result.disk.id, archil, ...(prefix ? { prefix } : {}) });
      const where = `Archil disk ${result.disk.id} (${result.disk.name})${store.prefix ? ` at ${store.prefix.slice(0, -1)}` : ""}`;
      if (!(await clearToLayOut(ctx, "create", store, where, "Or keep the atoll in a folder of its own with --prefix <folder>."))) return 1;
      const { created } = await createAtoll(store, { name, ...(str(ctx.args.flags.charter) ? { charter: str(ctx.args.flags.charter)! } : {}) });
      ctx.out.data("create", { disk: result.disk.id, name: result.disk.name, ...(store.prefix ? { prefix: store.prefix.slice(0, -1) } : {}), created });
      ctx.out.line(`${created ? "Created" : "Found"} the atoll on ${where}. Push code to it with \`atoll push --disk ${result.disk.name}${store.prefix ? ` --prefix ${store.prefix.slice(0, -1)}` : ""}\`.`);
      return 0;
    }
    const t = await target(ctx, name);
    if (!(await clearToLayOut(ctx, "create", t.store, t.describe, elsewhereHint(t)))) return 1;
    const { created } = await createAtoll(t.store, { name, ...(str(ctx.args.flags.charter) ? { charter: str(ctx.args.flags.charter)! } : {}) });
    ctx.out.data("create", { location: t.store.location, created });
    ctx.out.line(`${created ? "Created" : "Found"} ${t.describe}.`);
    return 0;
  },

  async push(ctx) {
    const entry = entryOf(ctx);
    const { system, bytes, version } = await loadProjectSystem(entry);
    const problems = checkSystem(system, new TextDecoder().decode(bytes));
    const errors = problems.filter((p) => p.severity === "error");
    if (errors.length) {
      printProblems(ctx.out, errors);
      ctx.out.data("push", { pushed: false, problems });
      return 1;
    }
    const t = await target(ctx, system.name);
    if (!(await clearToLayOut(ctx, "push", t.store, t.describe, elsewhereHint(t)))) return 1;
    const runtime = await ownBundle();
    const result = await push({ store: t.store, system, version, bundle: bytes, ...(runtime ? { runtime } : {}) });
    if (!result.ran) {
      ctx.out.line(`Another runner holds the lease (${result.heldBy}); try again in a minute.`);
      return 1;
    }
    let checkpoint: string | undefined;
    if (!ctx.args.flags["no-checkpoint"] && hasSnapshots(t.store)) {
      checkpoint = `atoll-push-${version}-${Date.now()}`;
      await recordCheckpoint(t.store, checkpoint, `push of ${version}`);
    }
    ctx.out.data("push", { pushed: true, version, previous: result.previous, seq: result.seq, location: t.store.location, checkpoint });
    ctx.out.line(`Pushed ${system.name} code ${version} to ${t.describe}${result.previous && result.previous !== version ? ` (was ${result.previous})` : ""}.${checkpoint ? ` Checkpoint ${checkpoint}.` : ""}`);
    for (const p of problems) ctx.out.line(`warning ${p.code}: ${p.message}`);
    return 0;
  },

  async send(ctx) {
    const [to, type, body] = ctx.args.positional;
    if (!to || !type) throw new UsageError("atoll send <to> <type> [json]");
    const t = await target(ctx);
    await requireAtoll(t);
    let parsed: unknown = {};
    if (body) {
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new UsageError(`The event body must be JSON: ${body}`);
      }
    }
    const result = await deliver(t.store, { to, type, body: parsed });
    ctx.out.line(result.duplicate ? `Already delivered: ${result.id}.` : `Delivered ${type} to ${to} as ${result.id}.`);
    let report: TickReport | undefined;
    if (ctx.args.flags.tick) {
      report = await tick({ store: t.store, ...(t.kind === "archil" ? { hands: t.store as any, snapshots: t.store as any } : {}) });
      ctx.out.line(summarizeReport(report));
    }
    ctx.out.data("send", { ...result, ...(report ? { report } : {}) });
    return 0;
  },

  async tick(ctx) {
    const t = await target(ctx);
    await requireAtoll(t);
    const max = str(ctx.args.flags.max);
    const report = await tick({
      store: t.store,
      ...(t.kind === "archil" ? { hands: t.store as any, snapshots: t.store as any } : {}),
      ...(max ? { maxTurns: Number(max) } : {}),
      ...(ctx.args.flags.checkpoint ? { checkpoint: true } : {}),
    });
    ctx.out.data("tick", { report });
    ctx.out.line(summarizeReport(report));
    return 0;
  },

  async status(ctx) {
    const t = await target(ctx);
    await requireAtoll(t);
    const full = await fiveAnswers(t.store);
    const address = ctx.args.positional[0];
    // With an address, the answers about that part (or part instance) only.
    const mine = (a: string) => !address || a === address || a.startsWith(`${address}/`);
    const answers = address
      ? {
          ...full,
          purpose: { ...full.purpose, parts: full.purpose.parts.filter((p) => mine(p.address)) },
          changed: full.changed.filter((c) => mine(c.part)),
          waiting: full.waiting.filter((w) => mine(w.address)),
          idle: full.idle.filter(mine),
          needs: { asks: full.needs.asks.filter((q) => mine(q.from)), outbox: full.needs.outbox.filter((o) => mine(o.for)) },
        }
      : full;
    if (address && answers.purpose.parts.length === 0 && answers.waiting.length === 0) {
      ctx.out.line(`No part "${address}" in this atoll.`);
      return 1;
    }
    ctx.out.data("status", { answers });
    if (!ctx.out.json) process.stdout.write(renderAnswers(answers));
    return answers.idle.length ? 1 : 0;
  },

  async why(ctx) {
    const what = ctx.args.positional[0];
    if (!what) throw new UsageError("atoll why <path|event-id|seq|fx-id|ask-id>");
    const t = await target(ctx);
    await requireAtoll(t);
    const report = await why(t.store, what);
    ctx.out.data("why", { report });
    if (report.chain.length === 0) {
      ctx.out.line(`The journal has no record of ${what}. (Files changed outside a turn show up in \`atoll check\`.)`);
      return 1;
    }
    for (const [i, step] of report.chain.entries()) {
      const head = `${i === 0 ? "" : "  ".repeat(Math.min(i, 6)) + "← "}${step.kind} ${step.seq} at ${step.at}`;
      const what2 = step.event ? `${step.part ?? ""} handled ${step.event.type} from ${step.event.from}${step.note ? `. ${step.note}` : ""}` : (step.note ?? "");
      ctx.out.line(`${head}: ${what2}${step.code ? ` [code ${step.code}]` : ""}`);
      for (const ref of step.evidence) ctx.out.line(`${"  ".repeat(Math.min(i, 6) + 1)}receipt ${ref}`);
    }
    ctx.out.line(report.complete ? "That's the whole chain: it starts with an event from outside the atoll." : "The record ends here; anything earlier isn't in the journal.");
    return 0;
  },

  async log(ctx) {
    const t = await target(ctx);
    await requireAtoll(t);
    const { records } = await readJournal(t.store);
    const since = str(ctx.args.flags.since);
    const cutoff = since ? Date.now() - parseDuration(since) : 0;
    const part = str(ctx.args.flags.part);
    const shown = records.filter((r) => Date.parse(r.at) >= cutoff && (!part || (r.kind === "turn" && r.part === part) || (r.kind === "effect" && r.deliver?.to === part)));
    ctx.out.data("log", { records: shown });
    for (const r of shown) ctx.out.line(describeRecord(r));
    if (!shown.length) ctx.out.line("No records.");
    return 0;
  },

  async asks(ctx) {
    const t = await target(ctx);
    await requireAtoll(t);
    const asks = await openAsks(t.store);
    ctx.out.data("asks", { asks });
    if (!asks.length) ctx.out.line("Nothing is waiting for you.");
    for (const a of asks) {
      ctx.out.line(`${a.id}  ${a.question}`);
      ctx.out.line(`      ${a.why}`);
      for (const o of a.options) ctx.out.line(`      ${o.id}${o.id === a.recommend ? " (recommended)" : ""}: ${o.label}. ${o.consequence}`);
      ctx.out.line(`      Default ${a.default} at ${a.expires}. Answer: atoll answer ${a.id} <option>`);
    }
    return 0;
  },

  async answer(ctx) {
    const [id, option] = ctx.args.positional;
    if (!id || !option) throw new UsageError("atoll answer <ask-id> <option> [--payload <json>]");
    const t = await target(ctx);
    await requireAtoll(t);
    const payloadText = str(ctx.args.flags.payload);
    const payload = payloadText ? JSON.parse(payloadText) : undefined;
    const ask = await answer(t.store, id, option, payload);
    ctx.out.line(`Answered ${id} (${ask.question}) with ${option}.`);
    let report: TickReport | undefined;
    if (!ctx.args.flags["no-tick"]) {
      report = await tick({ store: t.store, ...(t.kind === "archil" ? { hands: t.store as any, snapshots: t.store as any } : {}) });
      ctx.out.line(summarizeReport(report));
    }
    ctx.out.data("answer", { ask: id, option, ...(report ? { report } : {}) });
    return 0;
  },

  async check(ctx) {
    const problems: Problem[] = [];
    let system;
    if (ctx.project || str(ctx.args.flags.entry)) {
      try {
        const loaded = await loadProjectSystem(entryOf(ctx));
        system = loaded.system;
        problems.push(...checkSystem(loaded.system, new TextDecoder().decode(loaded.bytes)));
      } catch (error) {
        problems.push({ severity: "error", code: "CODE_DOES_NOT_LOAD", where: "system.ts", message: (error as Error).message });
      }
    }
    try {
      const t = await target(ctx, system?.name);
      if ((await atollInfo(t.store)).exists) problems.push(...(await checkAtoll(t.store, system)));
    } catch (error) {
      if (!(error instanceof NotInProject)) throw error;
    }
    ctx.out.data("check", { problems, ok: !problems.some((p) => p.severity === "error") });
    printProblems(ctx.out, problems);
    const errors = problems.filter((p) => p.severity === "error").length;
    ctx.out.line(errors ? `${errors} error${errors === 1 ? "" : "s"}.` : `No errors${problems.length ? `; ${problems.length} warning${problems.length === 1 ? "" : "s"}` : ""}.`);
    return errors ? 1 : 0;
  },

  async replay(ctx) {
    const t = await target(ctx);
    await requireAtoll(t);
    const codePath = str(ctx.args.flags.code);
    const loaded = codePath ? await loadProjectSystem(resolve(codePath)) : null;
    const system = loaded?.system ?? (await loadCurrentSystem(t.store));
    // Without --code, each recorded turn is replayed through the code version that recorded it: a check
    // that history is reproducible, across pushes. With --code, every turn goes through that one version.
    const report = await replay(t.store, system, loaded ? {} : { versions: (version) => loadSystemVersion(t.store, version) });
    ctx.out.data("replay", { report, code: loaded?.version ?? (await currentCodeVersion(t.store)) });
    printReplay(ctx.out, report, loaded ? `${codePath} (${loaded.version})` : "the code version that recorded each one");
    return report.different.length || report.errors.length ? 1 : 0;
  },

  async try(ctx) {
    const { system, version } = await loadProjectSystem(entryOf(ctx));
    const t = await target(ctx, system.name);
    await requireAtoll(t);
    const report = await replay(t.store, system);
    ctx.out.data("try", { report, code: version, current: await currentCodeVersion(t.store) });
    printReplay(ctx.out, report, `the working copy (${version})`);
    return 0;
  },

  async checkpoint(ctx) {
    const name = ctx.args.positional[0];
    if (!name || !/^[A-Za-z0-9_-]{1,100}$/.test(name)) throw new UsageError("atoll checkpoint <name>: letters, digits, - and _");
    const t = await target(ctx);
    await requireAtoll(t);
    if (!hasSnapshots(t.store)) throw new UsageError("Checkpoints need an Archil disk (--disk)");
    await recordCheckpoint(t.store, name, "by hand");
    ctx.out.data("checkpoint", { name });
    ctx.out.line(`Checkpointed the whole disk as ${name}. Archil can't delete checkpoints yet, so they accumulate.`);
    return 0;
  },

  async fork(ctx) {
    const t = await target(ctx);
    await requireAtoll(t);
    if (!hasSnapshots(t.store)) throw new UsageError("Forks need an Archil disk (--disk)");
    let checkpoint = str(ctx.args.flags.checkpoint);
    if (!checkpoint) {
      checkpoint = `atoll-fork-${Date.now()}`;
      await recordCheckpoint(t.store, checkpoint, "for a fork");
    }
    const name = str(ctx.args.flags.name) ?? `fork-${Date.now()}`;
    const branch = await t.store.branch(name, checkpoint);
    await t.store.put(paths.branch(name), `${JSON.stringify({ name, id: branch.id, checkpoint, at: new Date().toISOString(), reason: "atoll fork" }, null, 2)}\n`);
    ctx.out.data("fork", { branch: branch.id, name, checkpoint });
    ctx.out.line(`Forked the atoll at checkpoint ${checkpoint} into branch ${name}, disk ${branch.id}.`);
    ctx.out.line(`Every command takes it like any disk: atoll status --disk ${branch.id}`);
    return 0;
  },

  async door(ctx) {
    const sub = ctx.args.positional[0];
    const t = await target(ctx);
    if (t.kind !== "archil") throw new UsageError("A door needs an Archil disk (--disk)");
    await requireAtoll(t);
    const store = t.store as unknown as { archil: any; diskId: string; prefix: string };
    const manifest = await readJson<Manifest>(t.store, paths.manifest);
    const atollName = manifest?.name ?? ctx.project?.name;
    if (!atollName) throw new UsageError("Push code to the atoll before bringing up its door");
    const sandbox = await import("../door/sandbox.ts");
    const base = { archil: store.archil, diskId: store.diskId, atollName, ...(store.prefix ? { prefix: store.prefix.replace(/\/$/, "") } : {}), log: (l: string) => ctx.out.line(l) };
    if (sub === "up") {
      const runtimePath = str(ctx.args.flags.runtime);
      const runtime = runtimePath ? new Uint8Array(await readFile(runtimePath)) : await ownBundle();
      if (!runtime) throw new UsageError("door up copies the built CLI to the disk; run it from the build (dist/atoll.mjs) or pass --runtime <path>");
      // The door runs the pushed code in a sandbox that has none of this machine's environment. It may
      // reach the hosts that code's effects declare, and it gets the model keys that code calls its
      // models with, and no others.
      const system = await loadCurrentSystem(t.store);
      const plan = planModelKeys(system, process.env);
      if (plan.missing.length) {
        ctx.out.data("door", { up: null, refused: "model-keys", missing: plan.missing });
        for (const m of plan.missing) {
          const one = m.effects.length === 1;
          ctx.out.line(`${andList(m.effects)} ${one ? "calls its model" : "call their models"} with ${m.key} and ${one ? "has no stand-in" : "have no stand-ins"}, but ${m.key} isn't set here, so the door couldn't run ${one ? "it" : "them"}.`);
        }
        ctx.out.line(`Set ${andList(plan.missing.map((m) => m.key))} in your environment or in the project's .env, then run atoll door up again.`);
        return 1;
      }
      const idle = str(ctx.args.flags.idle);
      const result = await sandbox.doorUp({ ...base, runtimeBundle: runtime, ...(idle ? { idleTtlSeconds: Number(idle) } : {}), allow: declaredHosts(system), keys: keyRoutes(plan.env) });
      ctx.out.data("door", { up: result, modelKeys: Object.keys(plan.env), standIns: plan.standIns.flatMap((s) => s.effects) });
      ctx.out.line(`The door is up: https://${result.hostname}/ (sandbox ${result.sandboxId}). Its port token is in ~/.config/atoll/doors.json.`);
      const declared = result.network?.egress === "declared";
      if (declared) ctx.out.line(result.network!.allow.length ? `Outside Archil it can reach ${andList(result.network!.allow)}, and nothing else.` : "It can reach nothing outside Archil.");
      else ctx.out.line("This Archil plan can't set a sandbox's network policy, so the door reaches Archil's managed allowlist.");
      for (const c of plan.calls) {
        const from = ctx.dotenv?.loaded.includes(c.key) ? " (from .env)" : "";
        if (declared) ctx.out.line(`Archil adds ${c.key}${from} to its requests to ${modelHost(c.key)}, for ${andList(c.effects)}; the door doesn't hold it, and the value is never shown.`);
        else ctx.out.line(`Its service has ${c.key}${from}, for ${andList(c.effects)}; the value is never shown.`);
      }
      for (const m of plan.standIns) ctx.out.line(`${m.key} isn't set here, so ${andList(m.effects)} will answer with ${m.effects.length === 1 ? "its stand-in" : "their stand-ins"} in the door.`);
      return 0;
    }
    if (sub === "down") {
      const result = await sandbox.doorDown(base);
      ctx.out.data("door", { down: result });
      ctx.out.line(result.removed ? `The door is down (sandbox ${result.sandboxId} deleted).` : "There was no door.");
      return 0;
    }
    if (sub === "url" || sub === undefined) {
      const info = await sandbox.doorInfo(base);
      ctx.out.data("door", { info });
      ctx.out.line(info ? `https://${info.hostname}/ (${info.status}${info.hasToken ? ", token on this machine" : ", no token on this machine"})` : "No door. Bring one up with `atoll door up`.");
      return 0;
    }
    if (sub === "token") {
      const result = await sandbox.doorToken(base as any);
      ctx.out.data("door", { tokenId: (result as any).tokenId });
      ctx.out.line(`A new port token is stored in ~/.config/atoll/doors.json${ctx.args.flags.show ? `: ${(result as any).token}` : " (pass --show to print it once, for a clock's secret)"}.`);
      return 0;
    }
    if (sub === "call") {
      const path = ctx.args.positional[1] ?? "/status";
      const body = ctx.args.positional[2];
      const credential = await sandbox.readDoorCredential(atollName);
      if (!credential) throw new UsageError("No door token on this machine; run `atoll door up` or `atoll door token`");
      const response = await sandbox.callDoor({ hostname: credential.hostname, token: credential.token, path, ...(body ? { body: JSON.parse(body) } : {}) } as any);
      ctx.out.data("door", { response });
      ctx.out.line(JSON.stringify(response, null, 2));
      return 0;
    }
    throw new UsageError("atoll door up|down|url|token|call");
  },

  async clock(ctx) {
    const cron = str(ctx.args.flags.cron) ?? "*/15 * * * *";
    const disk = str(ctx.args.flags.disk) ?? ctx.project?.disk ?? "<disk>";
    const root = ctx.project?.root ?? process.cwd();
    let text: string;
    let kind: string;
    // A clock that ticks the atoll needs the model keys its code calls its models with; a door has its own.
    const models = ctx.args.flags.door ? { keys: [] as string[] } : await projectModelKeys(ctx);
    const keys = models.keys;
    const keyNote = keys.length ? `, and ${andList(keys)} for this atoll's models,` : "";
    if (ctx.args.flags.github) {
      kind = "github";
      text = `# .github/workflows/atoll-tick.yml: GitHub Actions as this atoll's clock.
# Add ARCHIL_API_KEY as a repository secret and ARCHIL_REGION as a repository variable.${keys.length ? `\n# Add ${andList(keys)} as ${keys.length === 1 ? "a repository secret" : "repository secrets"} too: this atoll's code calls its models with ${keys.length === 1 ? "it" : "them"}.` : ""}
name: atoll tick
on:
  schedule:
    - cron: "${cron}"
  workflow_dispatch: {}
concurrency: atoll-tick
jobs:
  tick:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx --no-install atoll tick --disk ${disk}
        env:
          ARCHIL_API_KEY: \${{ secrets.ARCHIL_API_KEY }}
          ARCHIL_REGION: \${{ vars.ARCHIL_REGION }}
${keys.map((key) => `          ${key}: \${{ secrets.${key} }}\n`).join("")}`;
    } else if (ctx.args.flags.launchd) {
      kind = "launchd";
      const minutes = /^\*\/(\d+) \* \* \* \*$/.exec(cron)?.[1] ?? "15";
      text = `<?xml version="1.0" encoding="UTF-8"?>
<!-- ~/Library/LaunchAgents/dev.atoll.${disk}.plist; load with: launchctl load -w ~/Library/LaunchAgents/dev.atoll.${disk}.plist -->
<!-- Put ARCHIL_API_KEY and ARCHIL_REGION${keyNote} in ~/.atoll/env (chmod 600); this job reads them from there. -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.atoll.${disk}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>set -a; . "$HOME/.atoll/env"; set +a; cd "${root}" &amp;&amp; npx --no-install atoll tick --disk ${disk}</string></array>
  <key>StartInterval</key><integer>${Number(minutes) * 60}</integer>
  <key>StandardOutPath</key><string>/tmp/atoll-${disk}.log</string>
  <key>StandardErrorPath</key><string>/tmp/atoll-${disk}.log</string>
</dict>
</plist>
`;
    } else if (ctx.args.flags.door) {
      kind = "door";
      text = `# Any scheduler can be the clock by asking the door to tick. The port token comes from
# \`atoll door token --show\`; keep it in your scheduler's secrets, never in a repository.
${cron} curl -fsS -X POST -H "X-Archil-Token: $ATOLL_DOOR_TOKEN" https://<door-hostname>/tick
`;
    } else {
      kind = "crontab";
      text = `# crontab -e: tick ${disk} on this machine. Put ARCHIL_API_KEY and ARCHIL_REGION${keyNote} in ~/.atoll/env (chmod 600).
${cron} /bin/sh -c 'set -a; . "$HOME/.atoll/env"; set +a; cd "${root}" && npx --no-install atoll tick --disk ${disk}' >> "$HOME/.atoll/${disk}.log" 2>&1
`;
    }
    const write = str(ctx.args.flags.write);
    if (write) {
      if (existsSync(write)) throw new UsageError(`${write} exists; Atoll never overwrites a file`);
      await mkdir(dirname(resolve(write)), { recursive: true });
      await writeFile(write, text);
    }
    ctx.out.data("clock", { kind, cron, text, modelKeys: keys, ...(write ? { written: write } : {}) });
    if (!ctx.out.json) process.stdout.write(text);
    ctx.out.line();
    if (models.error) ctx.out.line(`The project's code didn't load (${models.error}), so this names no model keys; add any its model effects need.`);
    ctx.out.line("Archil has no timers of its own: an atoll's waits advance only when something calls tick.");
    return 0;
  },

  async serve(ctx) {
    const t = await target(ctx);
    await requireAtoll(t);
    const { serve } = await import("../door/serve.ts");
    const port = Number(str(ctx.args.flags.port) ?? "8080");
    const host = str(ctx.args.flags.host) ?? (t.kind === "mount" ? "0.0.0.0" : "127.0.0.1");
    const tokenEnv = str(ctx.args.flags["token-env"]);
    const server = await serve({
      store: t.store,
      port,
      host,
      ...(tokenEnv && process.env[tokenEnv] ? { token: process.env[tokenEnv] } : {}),
      tick: () => tick({ store: t.store }),
      deliver: (event) => deliver(t.store, { ...event, from: event.from ?? "@door" }),
      status: () => fiveAnswers(t.store),
    });
    ctx.out.line(`atoll serve: ${server.url} for ${t.describe}`);
    await new Promise<void>((resolveStop) => {
      const stop = () => void server.close().then(resolveStop);
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
    return 0;
  },

  async ls(ctx) {
    const t = await target(ctx);
    await requireAtoll(t);
    const prefix = (ctx.args.positional[0] ?? "").replace(/^\/+/, "");
    const entries = await t.store.list(prefix);
    ctx.out.data("ls", { entries: entries.map((e) => ({ key: e.key, size: e.size })) });
    if (!prefix) {
      const tops = new Map<string, number>();
      for (const e of entries) {
        const top = e.key.includes("/") ? `${e.key.split("/")[0]}/` : e.key;
        tops.set(top, (tops.get(top) ?? 0) + 1);
      }
      for (const [name, count] of [...tops].sort()) ctx.out.line(name.endsWith("/") ? `${name.padEnd(14)} ${count} file${count === 1 ? "" : "s"}` : name);
    } else for (const e of entries) ctx.out.line(`${String(e.size).padStart(8)}  ${e.key}`);
    return 0;
  },

  async cat(ctx) {
    const path = ctx.args.positional[0];
    if (!path) throw new UsageError("atoll cat <path>");
    const t = await target(ctx);
    const text = asText(await t.store.get(path.replace(/^\/+/, "")));
    if (text === null) {
      ctx.out.line(`No such file: ${path}`);
      return 1;
    }
    ctx.out.data("cat", { path, text });
    if (!ctx.out.json) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  },

  async hook(ctx) {
    if (ctx.args.positional[0] !== "check-on-edit") throw new UsageError("atoll hook check-on-edit");
    if (process.env.CLAUDE_PLUGIN_OPTION_CHECK_ON_EDIT === "false") return 0;
    const input = await readStdin(2000);
    let file: string | undefined;
    try {
      const parsed = JSON.parse(input || "{}");
      file = parsed?.tool_input?.file_path ?? parsed?.tool_input?.path;
    } catch {
      return 0;
    }
    if (!file || !/\.(ts|mts|js|mjs)$/.test(file)) return 0;
    const project = findProject(dirname(resolve(file)));
    if (!project) return 0;
    const timer = setTimeout(() => process.exit(0), 4000);
    let problems: Problem[];
    try {
      const loaded = await loadProjectSystem(project.entry);
      problems = checkSystem(loaded.system).filter((p) => p.severity === "error");
    } catch (error) {
      problems = [{ severity: "error", code: "CODE_DOES_NOT_LOAD", where: relative(project.root, project.entry), message: (error as Error).message.split("\n").slice(0, 4).join(" ") }];
    }
    clearTimeout(timer);
    if (problems.length) {
      const text = `atoll check found ${problems.length} error${problems.length === 1 ? "" : "s"} in ${relative(project.root, project.entry)}:\n${problems.map((p) => `- ${p.code} at ${p.where}: ${p.message}`).join("\n")}`;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
    }
    return 0;
  },
};

/** The root of the atoll checkout this CLI runs from, if it runs from one. */
function atollCheckout(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8"));
        if (parsed.name === PACKAGE && existsSync(join(dir, "src", "runtime"))) return dir;
      } catch {
        return null;
      }
    }
    dir = dirname(dir);
  }
  return null;
}

async function recordCheckpoint(store: Store, name: string, reason: string): Promise<void> {
  if (!hasSnapshots(store)) throw new UsageError("Checkpoints need an Archil disk");
  const outcome = await withRunner({ store, ...(await currentCodeVersion(store) ? {} : {}) }, async (runner) => {
    await store.checkpoint(name);
    await runner.record({ v: 1, kind: "checkpoint", seq: runner.journal.nextSeq(), epoch: runner.lease.epoch, at: runner.now().toISOString(), name, reason } as JournalRecord);
  });
  if (!outcome.ran) throw new Error(`Another runner holds the lease (${outcome.heldBy}); try the checkpoint again shortly`);
}

function describeRecord(r: JournalRecord): string {
  const head = `${String(r.seq).padStart(5)} ${r.at} e${r.epoch}`;
  switch (r.kind) {
    case "turn":
      return `${head} turn     ${r.part} ← ${r.event.type} from ${r.event.from}${r.note ? `: ${r.note}` : ""}${r.writes.length ? ` (${r.writes.length} write${r.writes.length === 1 ? "" : "s"})` : ""}`;
    case "effect":
      return `${head} effect   ${r.effect} ${r.name} ${r.state}${r.error ? `: ${r.error}` : ""}`;
    case "failure":
      return `${head} failure  ${r.event.to} ← ${r.event.type} (attempt ${r.attempt}${r.dead ? ", dead-lettered" : ""}): ${r.error}`;
    case "answer":
      return `${head} answer   ${r.ask} = ${r.option} (${r.by})`;
    case "push":
      return `${head} push     code ${r.code}${r.previous ? ` (was ${r.previous})` : ""}`;
    case "checkpoint":
      return `${head} checkpoint ${r.name} (${r.reason})`;
    case "merge":
      return `${head} merge    ${r.writes.length + r.deletes.length} file(s) from branch ${r.branch} for ${r.effect}`;
    case "duplicate":
      return `${head} duplicate ${r.event}`;
  }
}

function printReplay(out: Output, report: ReplayReport, what: string): void {
  out.line(`Replayed ${report.turns} recorded turn${report.turns === 1 ? "" : "s"} through ${what}, each against the state it originally saw.`);
  out.line(`${report.same} behave the same; ${report.different.length} differ; ${report.errors.length} throw; ${report.unhandled.length} have no handler.`);
  for (const d of report.different) {
    out.line(`  turn ${d.seq} (${d.part} ← ${d.event}):`);
    for (const line of d.differences) out.line(`    - ${line}`);
  }
  for (const e of report.errors) out.line(`  turn ${e.seq} (${e.part} ← ${e.event}) throws: ${e.error}`);
  for (const u of report.unhandled) out.line(`  turn ${u.seq} (${u.part} ← ${u.event}) has no handler in this code`);
  out.line("This covers only what actually happened; events that never arrived aren't tested.");
}

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolveText) => {
    if (process.stdin.isTTY) return resolveText("");
    let data = "";
    const timer = setTimeout(() => resolveText(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolveText(data);
    });
  });
}

export async function main(argv: string[]): Promise<number> {
  // Output piped into head or grep may close early; that is not an error.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
  });
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const name = parsed.positional.shift() ?? "help";
  const out = new Output(Boolean(parsed.flags.json));
  const command = commands[name === "--help" ? "help" : name];
  if (!command || parsed.flags.help) {
    if (!command) process.stderr.write(`Unknown command "${name}". Run \`atoll help\`.\n`);
    if (parsed.flags.help && command) {
      const info = COMMANDS.find((c) => c.name === name);
      process.stdout.write(`${info?.usage}\n${info?.summary}\n`);
      return 0;
    }
    return 2;
  }
  try {
    const project = findProject();
    // Archil's setup prompts keep credentials in the project's .env, so the CLI reads it too.
    const dotenv = loadDotEnv(project?.root ?? process.cwd());
    return await command({ args: parsed, out, project, dotenv });
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    if (error instanceof NotInProject) {
      process.stderr.write(`${error.message}\n`);
      return 3;
    }
    process.stderr.write(`atoll ${name}: ${(error as Error).message}\n`);
    if (process.env.ATOLL_DEBUG) process.stderr.write(`${(error as Error).stack}\n`);
    return 1;
  }
}

if (process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith("/atoll.mjs") || process.argv[1].endsWith("/atoll"))) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

export { VERSION, readFileSync };
