// Release radar: watches npm packages, keeps a ledger of the releases it sees, tells me once about each
// major or minor one, and writes a digest every Monday. It is deterministic: no model. See README.md.

import { defineSystem, type Turn } from "@standing-systems/atoll";

/**
 * What I asked for, in my words. Atoll writes it into a new atoll's CHARTER.md under the system's name,
 * followed by each part's purpose; a test checks that the result is the CHARTER.md beside this file.
 */
const charter = `I build on a few npm packages, and I want to know when one of them moves without watching npm myself.

Watch each package I name, and check the registry every hour. When a package moves to a new major or
minor version, tell me once, with a link. Keep a record of patches too, but don't interrupt me for
them. Every Monday at 16:00 UTC, write me a digest of the week: what came out, and any package you
couldn't check.

The first version you see of a package is where it stands, not news, so take it as a baseline and
don't tell me about it. Compare each release with the last version you recorded, so that a minor
release followed quickly by a patch still counts as a minor move.

## Never

- Never tell me about the same release twice.
- Never tell me about a single failed check, since one failure is usually the network. Tell me after
  three in a row, and once more when you can read the registry again.
- Never reach anything but registry.npmjs.org, and never make more than 5,000 requests to it in a
  month.
- Never send anything to anyone but me. This system only reads.
- Never change what you watch, or your own code, without me.`;

/** Failed checks in a row before a watch tells me. One failure is usually the network. */
const FAILURES_BEFORE_TELLING = 3;
const DAY_MS = 86_400_000;

// ---- What the parts keep on disk ---------------------------------------------------------------------

/** parts/watch/<instance>/watch.json: the package this watch follows. */
interface WatchFile {
  package: string;
  url: string;
  since: string;
}

/** parts/watch/<instance>/latest.json: the version npm last called latest, with the receipt. */
interface LatestFile {
  version: string;
  previous: string | null;
  seenAt: string;
  evidence: string[];
}

/** parts/watch/<instance>/health.json: there only while checks are failing. */
interface HealthFile {
  failures: number;
  since: string;
  lastAt: string;
  lastError: string;
  evidence: string[];
}

/** parts/ledger/releases/<name>@<version>.json: one release, recorded once. */
interface ReleaseFile extends Classification {
  name: string;
  version: string;
  /** The stable version it was compared with. */
  previous: string | null;
  seenAt: string;
  recordedAt: string;
  reportedBy: string;
  event: string;
  evidence: string[];
  told: boolean;
}

/** parts/ledger/latest.json: the newest stable version recorded per package; the next release is compared with it. */
type Pointers = Record<string, { version: string; seenAt: string }>;

/** parts/digest/last.json: where the last digest ended, so the next one starts there. */
interface LastDigest {
  until: string;
  file: string;
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

// ---- npm names and semver ----------------------------------------------------------------------------

/** npm's rule for package names, scoped or not. It also keeps a name safe inside a file path. */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
/** What a version must look like before it is used in a file name. */
const VERSION_TEXT = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

export function isPackageName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 214 && PACKAGE_NAME.test(name);
}

/**
 * The registry's document for a package's latest version. The whole package document would do, but
 * rivetkit's is 5 MB; this one is a few KB and stays byte for byte the same until a release, so the
 * evidence it leaves dedupes.
 */
export function latestUrl(name: string): string {
  return `https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

function parseVersion(text: string): Semver | null {
  const m = SEMVER.exec(text);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null } : null;
}

function isNewer(a: Semver, b: Semver): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch > b.patch;
}

export type Change = "first" | "major" | "minor" | "patch" | "prerelease" | "older" | "unknown";

export interface Classification {
  change: Change;
  significant: boolean;
  reason: string;
}

/** The changes that move a package's pointer to this version. */
const MOVES_POINTER: ReadonlySet<Change> = new Set(["first", "major", "minor", "patch"]);

/**
 * Judges a release against the last stable version recorded for its package, not by its own number:
 * a minor release and a patch published between two checks still read as a minor move.
 */
export function classify(version: string, previous: string | null): Classification {
  const v = parseVersion(version);
  if (!v) return { change: "unknown", significant: false, reason: `"${version}" isn't a semver version` };
  if (v.pre !== null) return { change: "prerelease", significant: false, reason: "a prerelease" };
  const p = previous === null ? null : parseVersion(previous);
  if (!p) return { change: "first", significant: false, reason: "the first version recorded, a baseline" };
  if (!isNewer(v, p)) return { change: "older", significant: false, reason: `not newer than ${previous}, which is already recorded` };
  if (v.major !== p.major) return { change: "major", significant: true, reason: `a major release after ${previous}` };
  if (v.minor !== p.minor) return { change: "minor", significant: true, reason: `a minor release after ${previous}` };
  return { change: "patch", significant: false, reason: `a patch after ${previous}` };
}

// ---- Small helpers -----------------------------------------------------------------------------------

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

function parseJson(text: string | undefined): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The two fields the watch reads. The result keeps only these; the evidence keeps npm's whole answer. */
const FIELDS = ["name", "version"];

function check(t: Turn, w: WatchFile): void {
  t.effect("npm.get", { url: w.url, pick: FIELDS }, { then: "watch.fetched" });
  t.wait({ for: "watch.fetched", reason: `npm's answer about ${w.package}` });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (text: string, max = 300) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const unique = (refs: string[]) => [...new Set(refs)].sort();

function isoOr(value: unknown, fallback: string): string {
  const date = typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date(fallback).toISOString();
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");
const longDay = (d: Date) => `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
const when = (at: Date | string) => {
  const d = new Date(at);
  return `${longDay(d)} at ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

// ---- What the digest reads from the other parts' files ------------------------------------------------

/** Code-unit order, the same on every machine; localeCompare would depend on the runner's locale. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The ledger's records made in [since, until), read straight from its directory. Selecting by when the
 * ledger recorded a release, not when a watch saw it, puts even a late report in exactly one digest.
 */
async function releasesBetween(t: Turn, since: Date, until: Date): Promise<ReleaseFile[]> {
  const from = since.toISOString();
  const to = until.toISOString();
  const found: ReleaseFile[] = [];
  for (const path of await t.list("/parts/ledger/releases")) {
    if (!path.endsWith(".json")) continue;
    const release = await t.json<ReleaseFile>(`/parts/ledger/releases/${path}`);
    if (release && release.recordedAt >= from && release.recordedAt < to) found.push(release);
  }
  return found.sort((a, b) => byText(a.seenAt, b.seenAt) || byText(a.name, b.name));
}

interface WatchSummary {
  package: string;
  version: string | null;
  health: HealthFile | null;
}

async function watches(t: Turn): Promise<WatchSummary[]> {
  const found: WatchSummary[] = [];
  for (const path of await t.list("/parts/watch")) {
    if (!path.endsWith("/watch.json")) continue;
    const dir = `/parts/watch/${path.slice(0, -"/watch.json".length)}`;
    const w = await t.json<WatchFile>(`${dir}/watch.json`);
    if (!w) continue;
    const latest = await t.json<LatestFile>(`${dir}/latest.json`);
    found.push({ package: w.package, version: latest?.version ?? null, health: await t.json<HealthFile>(`${dir}/health.json`) });
  }
  return found.sort((a, b) => byText(a.package, b.package));
}

function renderDigest(since: Date, until: Date, releases: ReleaseFile[], watched: WatchSummary[]): string {
  const significant = releases.filter((r) => r.significant);
  const patches = releases.filter((r) => r.change === "patch");
  const started = releases.filter((r) => r.change === "first");
  const other = releases.filter((r) => !r.significant && r.change !== "patch" && r.change !== "first");
  const period = `between ${when(since)} and ${when(until)} UTC`;
  const counts = [significant.length ? plural(significant.length, "major or minor release") : "", patches.length ? plural(patches.length, "patch", "patches") : ""];
  const lines = [`# Releases, week ending ${longDay(until)}`, ""];
  lines.push(counts.some(Boolean) ? `${counts.filter(Boolean).join(" and ")}, recorded ${period}.` : `No new releases recorded ${period}.`);
  const section = (title: string, items: string[]) => {
    if (items.length > 0) lines.push("", `## ${title}`, "", ...items.map((item) => `- ${item}`));
  };
  const line = (r: ReleaseFile) => `${r.name} ${r.version}, ${r.reason} (${when(r.seenAt)} UTC)`;
  section("Major and minor releases", significant.map(line));
  section("Patches", patches.map(line));
  section("Other versions", other.map(line));
  section("Started watching", started.map((r) => `${r.name} at ${r.version}`));
  section(
    "Couldn't check",
    watched.flatMap((w) => (w.health ? [`${w.package}: the last ${plural(w.health.failures, "check")} failed, most recently with ${w.health.lastError}`] : [])),
  );
  section("Watching", watched.map((w) => `${w.package} ${w.version ?? "(no reading yet)"}`));
  return `${lines.join("\n")}\n`;
}

// ---- The system ----------------------------------------------------------------------------------------

export default defineSystem({
  name: "release-radar",
  charter,
  parts: {
    watch: {
      purpose: "Tell me about each new version of this package on npm",
      instances: true,
      schedules: [{ every: "1h", send: "watch.poll" }],
      on: {
        "watch.start": async (t) => {
          const name: unknown = t.event.body?.package;
          if (!isPackageName(name)) {
            t.tell(`I didn't start ${t.self}: ${JSON.stringify(name ?? null)} isn't an npm package name. Send it watch.start with {"package": "<name>"}.`);
            return;
          }
          const current = await t.json<WatchFile>("watch.json");
          if (current) {
            if (current.package === name) return t.note(`Already watching ${name}`);
            t.tell(`${t.self} already watches ${current.package}, so I didn't switch it to ${name}. Start another watch for ${name}.`);
            return;
          }
          const w: WatchFile = { package: name, url: latestUrl(name), since: t.now.toISOString() };
          t.write("watch.json", w);
          check(t, w);
          t.note(`Started watching ${name}; its first reading is a baseline`);
        },

        "watch.poll": async (t) => {
          const w = await t.json<WatchFile>("watch.json");
          if (!w) return t.note(`Nothing to check yet: send ${t.self} watch.start with {"package": "<name>"}`);
          check(t, w);
        },

        "watch.fetched": async (t) => {
          const w = await t.json<WatchFile>("watch.json");
          if (!w) return t.note("npm answered for a watch that isn't watching anything");
          const now = t.now.toISOString();
          const evidence = t.event.evidence ?? [];
          const reading = readLatest(t.event.body);
          const health = await t.json<HealthFile>("health.json");

          if (!reading.ok) {
            // Record the failure beside what the watch knows, and leave what it knows alone.
            const failures = (health?.failures ?? 0) + 1;
            t.write("health.json", { failures, since: health?.since ?? now, lastAt: now, lastError: reading.error, evidence } satisfies HealthFile);
            if (failures === FAILURES_BEFORE_TELLING) {
              t.tell(`I couldn't read ${w.package} from npm the last ${failures} times I checked, most recently: ${reading.error}. I'll keep checking every hour.`, { evidence });
            }
            return t.note(`Couldn't read ${w.package} from npm (${reading.error}): ${plural(failures, "failed check")} in a row. What it knows is unchanged.`);
          }

          const notes: string[] = [];
          if (health) {
            t.delete("health.json");
            if (health.failures >= FAILURES_BEFORE_TELLING) t.tell(`I can read ${w.package} from npm again, after ${health.failures} failed checks.`, { evidence });
            notes.push(`read ${w.package} again after ${plural(health.failures, "failed check")}`);
          }
          const latest = await t.json<LatestFile>("latest.json");
          if (latest?.version !== reading.version) {
            t.write("latest.json", { version: reading.version, previous: latest?.version ?? null, seenAt: now, evidence } satisfies LatestFile);
            t.send("ledger", "release.seen", { name: w.package, version: reading.version, seenAt: now }, { evidence });
            notes.push(latest ? `npm's latest ${w.package} moved from ${latest.version} to ${reading.version}` : `the first reading of ${w.package} is ${reading.version}`);
          }
          if (notes.length > 0) t.note(notes.join("; "));
        },
      },
    },

    ledger: {
      purpose: "Keep one record of every release a watch sees, and tell me once about each major or minor one",
      on: {
        "release.seen": async (t) => {
          t.wait({ for: "release.seen", reason: "the next release a watch reports" });
          const { name, version, seenAt } = t.event.body ?? {};
          if (!isPackageName(name) || typeof version !== "string" || !VERSION_TEXT.test(version)) {
            return t.note(`Ignored a release.seen without a package name and version: ${clip(JSON.stringify(t.event.body ?? null))}`);
          }
          // The business key is the package and version: a second report of either is the same release.
          const key = `${name}@${version}`;
          const path = `releases/${key}.json`;
          if ((await t.read(path)) !== null) return t.note(`Already recorded ${key}; nothing changed`);

          const pointers = (await t.json<Pointers>("latest.json")) ?? {};
          const previous = pointers[name]?.version ?? null;
          const verdict = classify(version, previous);
          const evidence = t.event.evidence ?? [];
          const record: ReleaseFile = {
            name,
            version,
            previous,
            ...verdict,
            seenAt: isoOr(seenAt, t.event.at),
            recordedAt: t.now.toISOString(),
            reportedBy: t.event.from,
            event: t.event.id,
            evidence,
            told: verdict.significant,
          };
          t.write(path, record);
          if (MOVES_POINTER.has(verdict.change)) t.write("latest.json", { ...pointers, [name]: { version, seenAt: record.seenAt } });
          if (verdict.significant) t.tell(`${name} ${version} is out: ${verdict.reason}. https://www.npmjs.com/package/${name}/v/${version}`, { evidence });
          t.note(`Recorded ${key}: ${verdict.reason}${verdict.significant ? "; told you" : ""}`);
        },
      },
    },

    digest: {
      purpose: "Every Monday, give me a digest of the week's releases",
      schedules: [{ cron: "0 16 * * 1", tz: "UTC", send: "digest.due" }],
      on: {
        "digest.due": async (t) => {
          const last = await t.json<LastDigest>("last.json");
          const until = t.now;
          const since = last ? new Date(last.until) : new Date(until.getTime() - 7 * DAY_MS);
          const releases = await releasesBetween(t, since, until);
          const text = renderDigest(since, until, releases, await watches(t));
          const file = `digests/${until.toISOString().slice(0, 10)}.md`;
          t.write(file, text);
          t.write("last.json", { until: until.toISOString(), file } satisfies LastDigest);
          t.tell(text, { evidence: unique(releases.flatMap((r) => r.evidence)) });
          t.note(`Wrote ${file} from ${plural(releases.length, "ledger record")} seen since ${since.toISOString()}`);
        },
      },
    },
  },

  effects: {
    "npm.get": {
      kind: "http",
      allow: ["registry.npmjs.org"],
      // Two packages checked hourly use about 1,500 calls a month.
      budget: { calls: 5000, per: "month" },
    },
  },
});
