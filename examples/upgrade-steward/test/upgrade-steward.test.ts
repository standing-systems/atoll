// Upgrade steward against what really happened. The fixtures are what its two commands answered on an
// Archil disk on 10 November 2026 at 03:04 UTC, keeping tj/commander.js at its v12.1.0 tag (commit
// 970ecae), as test/live/steward.test.ts in the Atoll repository runs it:
//
//   sync-first.json     the first sync: a clone, `npm ci`, and the repository's 1,104 tests, which pass
//   sync-again.json     the next sync, with nothing new upstream: nothing installed, no tests run
//   trial-passes.json   prettier 3.9.10 on a branch: the tests pass
//   trial-breaks.json   typescript 7.0.2 on a branch: one suite fails
//   trial-missing.json  prettier 99.99.99 on a branch: npm has no such version
//
// Each is the effect's whole result, except that a sync's list of 224 changed files is cut to its counts.
// Where a test needs an answer that didn't happen (the tests failing at head, a dependency gone), it
// changes the summary line of a recorded one and says so. The last test runs both commands for real, in
// a shell, against a repository it makes on this machine.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkAtoll, checkSystem } from "@standing-systems/atoll";
import { testAtoll } from "@standing-systems/atoll/testing";
import system, { classify, latestUrl, saveFlags, slug, syncCommand, trialAddress, trialCommand, watchAddress, type Dep, type PullArgs } from "../system.ts";

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  branch?: string;
  checkpoint?: string;
}

const fixture = (name: string): ExecResult => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as ExecResult;
const SYNC_FIRST = fixture("sync-first.json");
const SYNC_AGAIN = fixture("sync-again.json");
const PASSES = fixture("trial-passes.json");
const BREAKS = fixture("trial-breaks.json");
const MISSING = fixture("trial-missing.json");

const MARK = "__STEWARD__ ";
const HEAD = "970ecae402b253de691e6a9066fea22f38fe7431";
const NEXT_HEAD = "3f0c1d2e4b5a69788796a5b4c3d2e1f00f1e2d3c";
const REPO = { url: "https://github.com/tj/commander.js", ref: "v12.1.0", test: "npm test" };
const START = "2026-11-09T18:00:00.000Z";

/** The summary a command's output ends with. */
function summaryOf(result: ExecResult): any {
  return JSON.parse(result.stdout.split("\n").filter((line) => line.startsWith(MARK)).at(-1)!.slice(MARK.length));
}

/** A recorded result with its summary changed: an answer that didn't happen, built from one that did. */
function withSummary(result: ExecResult, change: (summary: any) => object): ExecResult {
  const lines = result.stdout.split("\n");
  const last = lines.map((line) => line.startsWith(MARK)).lastIndexOf(true);
  lines[last] = MARK + JSON.stringify(change(JSON.parse(lines[last]!.slice(MARK.length))));
  return { ...result, stdout: lines.join("\n") };
}

/** What the steward meets: npm, the microVM that syncs, the one that runs trials, and GitHub. */
class World {
  /** What npm calls latest, by package. A package not named here is at the version the repository has. */
  latest: Record<string, string> = {};
  /** Packages whose requests fail, and the status npm answers them with. */
  readonly failing = new Map<string, number>();
  /** What the next sync answers. */
  sync: ExecResult = SYNC_FIRST;
  /** When set, the repository depends on only these: the recorded syncs, cut to a few of their 15 dependencies. */
  only: string[] | null = null;
  /** How a trial ends, by "name@version". One not named here installs and passes, as prettier 3.9.10 did. */
  trials: Record<string, ExecResult | Error> = { "prettier@3.9.10": PASSES, "typescript@7.0.2": BREAKS, "prettier@99.99.99": MISSING };
  /** What GitHub is asked, and what it answers. */
  readonly pulls: PullArgs[] = [];
  pull: (args: PullArgs) => unknown = () => ({ requested: true, repo: "tj/commander.js", event: "atoll-upgrade" });

  /** What a sync answers now: the result set above, with only the dependencies this world has. */
  synced(): ExecResult {
    const only = this.only;
    return only ? withSummary(this.sync, (summary) => (summary.deps ? { ...summary, deps: (summary.deps as Dep[]).filter((d) => only.includes(d.name)) } : summary)) : this.sync;
  }

  installed(name: string): string | null {
    return ((summaryOf(this.synced()).deps ?? []) as Dep[]).find((d) => d.name === name)?.installed ?? null;
  }

  readonly stubs = {
    // A stub's answer skips the runtime's `pick`, so it answers with the picked fields.
    "npm.get": (args: { url: string }) => {
      const name = decodeURIComponent(new URL(args.url).pathname.split("/")[1] ?? "");
      const failing = this.failing.get(name);
      if (failing) return { status: failing, text: "Service Unavailable" };
      return { status: 200, json: { name, version: this.latest[name] ?? this.installed(name) } };
    },
    "repo.sync": () => this.synced(),
    "trial.run": (args: { command: string }) => {
      const [, name, version] = /npm install [^\n]*? '((?:@[^'@/]+\/)?[^'@]+)@([^'@]+)' >/.exec(args.command) ?? [];
      const given = this.trials[`${name}@${version}`];
      if (given instanceof Error) throw given;
      return given ?? withSummary(PASSES, (summary) => ({ ...summary, installed: version }));
    },
    "pr.open": (args: PullArgs) => {
      this.pulls.push(args);
      return this.pull(args);
    },
  };
}

type Atoll = Awaited<ReturnType<typeof testAtoll>>;
const open: Atoll[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A steward that has just been told to keep commander.js, with the world as given. */
async function steward(setup: (world: World) => void = () => {}) {
  const world = new World();
  setup(world);
  const s = await testAtoll(system, { now: START, stubs: world.stubs });
  open.push(s);
  await s.send("repo", "repo.track", { url: REPO.url, ref: REPO.ref });
  await s.tick();
  return { s, world };
}

/** Everything the atoll has told me, oldest first. */
async function told(s: Atoll): Promise<string[]> {
  return (await s.journal()).flatMap((r) => (r.kind === "turn" ? r.notices.map((n) => n.text) : []));
}

const trial = (s: Atoll, name: string, version: string) => s.json(`parts/${trialAddress(name, version)}/trial.json`);
const waiting = (s: Atoll, address: string) => s.json(`parts/${address}/waiting.json`);
const upgrades = { prettier: "3.9.10", typescript: "7.0.2" };
/**
 * A world whose repository has four of commander's fifteen dependencies. Most tests are about one or two
 * of them, and a steward with fifteen watches takes three times as long to tick.
 */
const few = (setup: (world: World) => void = () => {}) => (world: World) => {
  world.only = ["@types/node", "jest", "prettier", "typescript"];
  setup(world);
};

// Each test ticks an atoll on disk many times; a busy machine can take longer than vitest's default 5 s.
describe("upgrade steward", { timeout: 60_000 }, () => {
  test("keeps the repository, watches every dependency, and leaves alone what is up to date", async () => {
    const { s, world } = await steward();
    expect(s.calls("repo.sync").map((c) => c.args)).toEqual([{ command: syncCommand(REPO, null) }]);
    expect(await s.json("parts/repo/repo.json")).toMatchObject({
      url: REPO.url,
      github: "tj/commander.js",
      ref: "v12.1.0",
      test: "npm test",
      head: HEAD,
      baseline: { head: HEAD, passed: true, seconds: 32 },
    });
    const deps = (await s.json("parts/repo/deps.json")) as Dep[];
    expect(deps.map((d) => d.name)).toEqual((summaryOf(SYNC_FIRST).deps as Dep[]).map((d) => d.name).sort());
    expect(deps).toHaveLength(15);
    expect(deps.find((d) => d.name === "typescript")).toEqual({ name: "typescript", section: "devDependencies", spec: "^5.0.4", installed: "5.4.5" });

    // One watch per dependency, each asking npm once; a scoped package gets a plain instance name.
    expect((await s.list("parts/watch/")).filter((path) => path.endsWith("/watch.json"))).toHaveLength(15);
    expect(await s.json("parts/watch/types__node/watch.json")).toMatchObject({ name: "@types/node", installed: "20.12.7", spec: "^20.2.5" });
    expect(s.calls("npm.get").map((c) => c.args.url).sort()).toEqual(deps.map((d) => latestUrl(d.name)).sort());
    expect(await s.json("parts/watch/prettier/latest.json")).toMatchObject({ version: world.installed("prettier"), trial: null });

    // Nothing is newer than what the repository has, so nothing is tried and I hear nothing.
    expect(s.calls("trial.run")).toEqual([]);
    expect(await s.list("parts/trial/")).toEqual([]);
    expect(await told(s)).toEqual([]);
    expect(await s.asks()).toEqual([]);
    expect(await waiting(s, "watch/prettier")).toMatchObject({ status: "waiting", waits: [expect.objectContaining({ until: "2026-11-10T00:00:00.000Z" })] });
  });

  test("tries each newer version on a branch, and tells me which is safe and which breaks", async () => {
    const { s } = await steward((world) => (world.latest = upgrades));
    expect(s.calls("trial.run").map((c) => c.args.command).sort()).toEqual(
      [
        trialCommand({ package: "prettier", version: "3.9.10", section: "devDependencies", spec: "^3.2.5" }, "npm test"),
        trialCommand({ package: "typescript", version: "7.0.2", section: "devDependencies", spec: "^5.0.4" }, "npm test"),
      ].sort(),
    );

    expect(await trial(s, "prettier", "3.9.10")).toMatchObject({
      state: "passed",
      change: "minor",
      reason: "a minor release after 3.2.5",
      from: "3.2.5",
      head: HEAD,
      branch: PASSES.branch,
      checkpoint: PASSES.checkpoint,
      seconds: { install: 2, test: 27 },
      changed: ["package-lock.json", "package.json"],
      pull: { state: "asked" },
    });
    expect(await trial(s, "typescript", "7.0.2")).toMatchObject({
      state: "failed",
      change: "major",
      from: "5.4.5",
      head: HEAD,
      branch: BREAKS.branch,
      detail: "the tests exited 1",
      seconds: { install: 5, test: 22 },
      pull: null,
    });

    const notices = await told(s);
    expect(notices).toHaveLength(2);
    expect(notices).toContain(
      `prettier 3.9.10 is safe for tj/commander.js at 970ecae: the tests pass with it (27 s). It is a minor release after 3.2.5, and it changes package-lock.json and package.json.\n\nThe checkout it left is on branch ${PASSES.branch}.`,
    );
    const broke = notices.find((n) => n.startsWith("typescript 7.0.2 breaks"))!;
    expect(broke.split("\n\n")[0]).toBe("typescript 7.0.2 breaks tj/commander.js at 970ecae: the tests pass without it and fail with it. It is a major release after 5.4.5. The last lines:");
    expect(broke).toContain("Test Suites: 1 failed, 101 passed, 102 total");
    expect(broke.endsWith(`The checkout it left is on branch ${BREAKS.branch}.`)).toBe(true);
    // The notice quotes the end of the run; the trial keeps more of it, and neither has the summary line.
    expect(broke.split("\n").length).toBeLessThan(25);
    const output = (await s.read("parts/trial/typescript-7.0.2/output.txt"))!;
    expect(output).toContain("FAIL tests/ts-imports.test.ts");
    expect(output).not.toContain(MARK.trim());
    expect(broke).not.toContain(MARK.trim());

    // A trial that failed is finished. One that passed waits for my answer, and for nothing else.
    expect(await waiting(s, "trial/typescript-7.0.2")).toMatchObject({ status: "done" });
    expect(await waiting(s, "trial/prettier-3.9.10")).toMatchObject({ status: "waiting", waits: [expect.objectContaining({ for: "pr.done" })] });
    expect(await checkAtoll(s.store, system)).toEqual([]);
  });

  test("asks GitHub for a pull request only after I approve, with exactly what I approved", async () => {
    const { s, world } = await steward(few((w) => (w.latest = upgrades)));
    const asks = await s.asks();
    expect(asks).toHaveLength(1);
    const approved: PullArgs = {
      repo: "tj/commander.js",
      package: "prettier",
      version: "3.9.10",
      from: "3.2.5",
      section: "devDependencies",
      save: "--save-dev",
      head: HEAD,
      trial: "trial/prettier-3.9.10",
      branch: PASSES.branch!,
      evidence: (asks[0]!.payload as PullArgs).evidence,
    };
    expect(asks[0]).toMatchObject({
      question: "Ask GitHub to open a pull request on tj/commander.js that upgrades prettier from 3.2.5 to 3.9.10, whose tests passed on a copy at 970ecae?",
      default: "deny",
      payload: approved,
    });
    expect(approved.evidence.length).toBeGreaterThan(0);
    expect(world.pulls).toEqual([]);

    await s.answer(asks[0]!.id, "approve");
    expect(world.pulls).toEqual([approved]);
    expect((await trial(s, "prettier", "3.9.10")).pull).toMatchObject({ state: "requested", detail: null });
    expect((await told(s)).at(-1)).toBe("I asked GitHub to open the pull request for prettier 3.9.10. The repository's atoll-upgrade workflow makes the change and opens it.");
    expect(await waiting(s, "trial/prettier-3.9.10")).toMatchObject({ status: "done" });
    expect(await s.asks()).toEqual([]);
  });

  test("a pull request I decline, or never answer, is never asked for", async () => {
    const declined = await steward(few((w) => (w.latest = upgrades)));
    await declined.s.answer((await declined.s.asks())[0]!.id, "deny");
    expect(declined.world.pulls).toEqual([]);
    expect((await trial(declined.s, "prettier", "3.9.10")).pull).toMatchObject({ state: "declined" });
    expect(await waiting(declined.s, "trial/prettier-3.9.10")).toMatchObject({ status: "done" });

    // An approval left unanswered counts as no after three days.
    const ignored = await steward(few((w) => (w.latest = upgrades)));
    await ignored.s.advance("4d");
    expect(ignored.world.pulls).toEqual([]);
    expect((await trial(ignored.s, "prettier", "3.9.10")).pull).toMatchObject({ state: "declined" });
    expect(await ignored.s.asks()).toEqual([]);
  });

  test("when GitHub can't be asked, or may not have heard, it says which and how to do it by hand", async () => {
    const refused = await steward(
      few((w) => {
        w.latest = upgrades;
        w.pull = () => ({ requested: false, reason: "GITHUB_TOKEN isn't set where the steward runs" });
      }),
    );
    await refused.s.answer((await refused.s.asks())[0]!.id, "approve");
    expect((await trial(refused.s, "prettier", "3.9.10")).pull).toMatchObject({ state: "not-requested", detail: "GITHUB_TOKEN isn't set where the steward runs" });
    expect((await told(refused.s)).at(-1)).toBe(
      "You approved a pull request for prettier 3.9.10, but I couldn't ask GitHub for it: GITHUB_TOKEN isn't set where the steward runs. To make the change yourself: npm install --save-dev prettier@3.9.10",
    );

    const unsure = await steward(
      few((w) => {
        w.latest = upgrades;
        w.pull = () => ({ requested: false, inDoubt: true, reason: "GitHub didn't confirm it" });
      }),
    );
    await unsure.s.answer((await unsure.s.asks())[0]!.id, "approve");
    expect((await trial(unsure.s, "prettier", "3.9.10")).pull).toMatchObject({ state: "unknown" });
    expect((await told(unsure.s)).at(-1)).toBe("I don't know whether GitHub got the request for a pull request for prettier 3.9.10: GitHub didn't confirm it. Look for it before asking again.");
  });

  test("a version is tried once; the next one is a trial of its own; and I can ask for one again", async () => {
    const { s, world } = await steward(few((w) => (w.latest = { prettier: "3.9.10" })));
    expect(s.calls("trial.run")).toHaveLength(1);

    // Six hours on, npm says the same, and so does a second report sent by hand: nothing runs.
    await s.advance("6h");
    await s.send(trialAddress("prettier", "3.9.10"), "trial.start", { package: "prettier", version: "3.9.10" });
    await s.tick();
    expect(s.calls("trial.run")).toHaveLength(1);
    expect(await told(s)).toHaveLength(1);

    // A patch comes out. It is judged against what the repository has, so it is a minor move too.
    world.latest = { prettier: "3.9.11" };
    await s.advance("6h");
    expect(s.calls("trial.run")).toHaveLength(2);
    expect(await trial(s, "prettier", "3.9.11")).toMatchObject({ state: "passed", change: "minor", from: "3.2.5" });
    expect(await s.json("parts/watch/prettier/latest.json")).toMatchObject({ version: "3.9.11", trial: "trial/prettier-3.9.11" });

    // Asking by hand runs it again, on a branch of its own.
    await s.send(trialAddress("prettier", "3.9.10"), "trial.retry", {});
    await s.tick();
    expect(s.calls("trial.run")).toHaveLength(2);
    await s.send(trialAddress("prettier", "3.9.10"), "trial.retry", { again: true });
    await s.tick();
    expect(s.calls("trial.run")).toHaveLength(3);
  });

  test("a version npm doesn't have can't be installed, and that is said, not called a failure of the tests", async () => {
    const { s } = await steward(few());
    await s.send(trialAddress("prettier", "99.99.99"), "trial.start", { package: "prettier", version: "99.99.99" });
    await s.tick();
    // Sent by hand with only a name and a version: the repository's own record supplies the rest.
    expect(await trial(s, "prettier", "99.99.99")).toMatchObject({ state: "not-installable", from: "3.2.5", section: "devDependencies", spec: "^3.2.5", branch: MISSING.branch, pull: null });
    const [notice] = await told(s);
    expect(notice!.split("\n\n")[0]).toBe("I couldn't install prettier 99.99.99 into tj/commander.js at 970ecae, so its tests never ran. The last lines:");
    expect(notice).toContain("npm error notarget No matching version found for prettier@99.99.99.");
    expect(await s.asks()).toEqual([]);
  });

  test("a trial that never reports is told as that, and can be tried again", async () => {
    const { s, world } = await steward(few((w) => {
      w.latest = { prettier: "3.9.10" };
      w.trials["prettier@3.9.10"] = new Error("Exec on dsk-0000000000111e0a/workspace timed out (Archil allows 5 minutes per command). The command may or may not have finished.");
    }));
    expect(await trial(s, "prettier", "3.9.10")).toMatchObject({ state: "errored", branch: null });
    expect(await told(s)).toEqual([
      "I couldn't try prettier 3.9.10 on tj/commander.js at 970ecae: Exec on dsk-0000000000111e0a/workspace timed out (Archil allows 5 minutes per command). The command may or may not have finished.. Send trial/prettier-3.9.10 trial.retry to try again.",
    ]);
    world.trials["prettier@3.9.10"] = PASSES;
    await s.send(trialAddress("prettier", "3.9.10"), "trial.retry", {});
    await s.tick();
    expect(await trial(s, "prettier", "3.9.10")).toMatchObject({ state: "passed", branch: PASSES.branch });
  });

  test("holds every trial while the repository's own tests fail, tells me once, and lets them go when they pass", async () => {
    // The first sync as it happened, except that here the repository's own tests exit 1.
    const red = withSummary(SYNC_FIRST, (summary) => ({ ...summary, test: "1" }));
    const { s, world } = await steward(
      few((w) => {
        w.latest = upgrades;
        w.sync = red;
      }),
    );
    expect(await s.json("parts/repo/repo.json")).toMatchObject({ head: HEAD, baseline: { head: HEAD, passed: false } });
    expect(s.calls("trial.run")).toEqual([]);
    expect(await trial(s, "prettier", "3.9.10")).toMatchObject({ state: "held", detail: "the repository's own tests fail at 970ecae without any upgrade" });
    expect(await trial(s, "typescript", "7.0.2")).toMatchObject({ state: "held" });
    let notices = await told(s);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.split("\n\n")[0]).toBe("tj/commander.js's own tests fail at 970ecae, before any upgrade. I'm holding every trial until they pass. The last lines:");

    // The next sync finds the same commit and doesn't run the tests again; nothing new to say.
    world.sync = withSummary(SYNC_AGAIN, (summary) => summary);
    await s.advance("6h");
    expect(s.calls("repo.sync").at(-1)!.args).toEqual({ command: syncCommand(REPO, HEAD) });
    expect(s.calls("trial.run")).toEqual([]);
    expect(await told(s)).toHaveLength(1);

    // A fix lands upstream: a new commit, and the tests pass at it. The held trials run.
    world.sync = withSummary(SYNC_FIRST, (summary) => ({ ...summary, head: NEXT_HEAD, install: "skipped" }));
    await s.advance("6h");
    expect(await s.json("parts/repo/repo.json")).toMatchObject({ head: NEXT_HEAD, baseline: { head: NEXT_HEAD, passed: true } });
    expect(s.calls("trial.run")).toHaveLength(2);
    expect(await trial(s, "prettier", "3.9.10")).toMatchObject({ state: "passed", detail: null });
    expect(await trial(s, "typescript", "7.0.2")).toMatchObject({ state: "failed" });
    notices = await told(s);
    expect(notices[1]).toBe("tj/commander.js's own tests pass again at 3f0c1d2. Trials can run.");
    expect(notices).toHaveLength(4);
  });

  test("follows the repository: a dependency that moves is judged afresh, and one that leaves is dropped", async () => {
    const { s, world } = await steward((w) => (w.latest = { typescript: "7.0.2" }));
    expect(await s.json("parts/watch/typescript/latest.json")).toMatchObject({ version: "7.0.2", trial: "trial/typescript-7.0.2" });
    const before = s.calls("npm.get").length;

    // Upstream moves to typescript 7.0.2 itself and stops using prettier (the recorded sync, with those two changes).
    world.sync = withSummary(SYNC_FIRST, (summary) => ({
      ...summary,
      head: NEXT_HEAD,
      deps: (summary.deps as Dep[]).filter((d) => d.name !== "prettier").map((d) => (d.name === "typescript" ? { ...d, spec: "^7.0.2", installed: "7.0.2" } : d)),
    }));
    await s.advance("6h");
    expect(await s.json("parts/watch/typescript/watch.json")).toMatchObject({ spec: "^7.0.2", installed: "7.0.2" });
    expect(await s.json("parts/watch/typescript/latest.json")).toMatchObject({ version: "7.0.2", trial: null });
    expect(await waiting(s, "watch/prettier")).toMatchObject({ status: "done" });
    expect(((await s.json("parts/repo/deps.json")) as Dep[]).map((d) => d.name)).not.toContain("prettier");
    // All 15 watches were due their own six-hourly check in that tick, prettier's last one among them. The
    // sync told only the watch whose dependency had changed, and that one asked npm once more.
    expect(s.calls("npm.get").length - before).toBe(16);
    expect(s.calls("npm.get").filter((c) => c.args.url === latestUrl("typescript"))).toHaveLength(3);
    expect(s.calls("trial.run")).toHaveLength(1);

    // A dropped watch no longer polls; the 14 that are left do.
    const asked = s.calls("npm.get").length;
    await s.advance("6h");
    expect(s.calls("npm.get").length - asked).toBe(14);
    expect(s.calls("npm.get").slice(asked).map((c) => c.args.url)).not.toContain(latestUrl("prettier"));
  });

  test("a prerelease is never tried, and npm failing is told once after three checks", async () => {
    const { s, world } = await steward(few((w) => (w.latest = { typescript: "8.0.0-beta.1", prettier: "3.0.0" })));
    expect(s.calls("trial.run")).toEqual([]);
    expect(await s.json("parts/watch/typescript/latest.json")).toMatchObject({ version: "8.0.0-beta.1", trial: null });
    expect(await s.json("parts/watch/prettier/latest.json")).toMatchObject({ version: "3.0.0", trial: null });

    world.failing.set("jest", 503);
    await s.advance("6h");
    await s.advance("6h");
    expect(await told(s)).toEqual([]);
    await s.advance("6h");
    expect(await told(s)).toEqual(["I couldn't read jest from npm the last 3 times I checked, most recently: HTTP 503. I'll keep checking every six hours."]);
    expect(await s.json("parts/watch/jest/health.json")).toMatchObject({ failures: 3, lastError: "HTTP 503" });
    world.failing.clear();
    await s.advance("6h");
    expect((await told(s)).at(-1)).toBe("I can read jest from npm again, after 3 failed checks.");
    expect(await s.read("parts/watch/jest/health.json")).toBeNull();
  });

  test("a sync that fails is told the first time, leaves what it knew alone, and is told again when it works", async () => {
    const { s, world } = await steward(few());
    // What the command prints when git can't reach the repository, as the last test shows it for real.
    world.sync = { exitCode: 91, stdout: `fatal: unable to access 'https://github.com/tj/commander.js/': Could not resolve host: github.com\n${MARK}{"kind":"sync","stage":"git"}`, stderr: "" };
    await s.advance("6h");
    await s.advance("6h");
    expect(await told(s)).toEqual([
      "I couldn't reach the repository for tj/commander.js:\n\nfatal: unable to access 'https://github.com/tj/commander.js/': Could not resolve host: github.com\n\nThe checkout is as it was. I'll try again at the next sync.",
    ]);
    expect(await s.json("parts/repo/health.json")).toMatchObject({ failures: 2 });
    expect(await s.json("parts/repo/repo.json")).toMatchObject({ head: HEAD, baseline: { passed: true } });
    world.sync = SYNC_AGAIN;
    await s.advance("6h");
    expect((await told(s)).at(-1)).toBe("I can sync tj/commander.js again, after 2 failed syncs.");
    expect(await s.read("parts/repo/health.json")).toBeNull();
  });

  test("refuses what it can't keep, and what isn't its to try", async () => {
    const world = new World();
    const s = await testAtoll(system, { now: START, stubs: world.stubs });
    open.push(s);
    await s.send("repo", "repo.track", { url: "git@github.com:tj/commander.js.git" });
    await s.send("repo", "repo.track", { url: "https://gitlab.com/tj/commander.js" });
    await s.send("repo", "repo.track", { url: REPO.url, ref: "--upload-pack=touch /tmp/x" });
    await s.send("repo", "repo.track", { url: REPO.url, test: "npm test\nrm -rf /" });
    await s.tick();
    expect(s.calls("repo.sync")).toEqual([]);
    expect(await s.read("parts/repo/repo.json")).toBeNull();
    expect(await told(s)).toHaveLength(4);

    await s.send("repo", "repo.track", { url: `${REPO.url}.git`, ref: REPO.ref, test: "npx --no-install jest" });
    await s.tick();
    expect(await s.json("parts/repo/repo.json")).toMatchObject({ url: REPO.url, github: "tj/commander.js", test: "npx --no-install jest" });
    await s.send("repo", "repo.track", { url: "https://github.com/tj/co" });
    await s.send("trial/prettier-3.9.10", "trial.start", { package: "typescript", version: "7.0.2" });
    await s.send(trialAddress("left-pad", "1.3.0"), "trial.start", { package: "left-pad", version: "1.3.0" });
    await s.send(trialAddress("prettier", "3.9.10"), "trial.start", { package: "prettier", version: "3.9.10; rm -rf /" });
    await s.tick();
    expect((await told(s)).slice(4)).toEqual([
      "I already keep tj/commander.js, so I didn't switch to tj/co. Give tj/co an atoll of its own.",
      "trial/prettier-3.9.10 isn't where typescript 7.0.2 is tried. Send trial.start to trial/typescript-7.0.2.",
      "I didn't try left-pad 1.3.0: left-pad isn't a dependency of the repository I keep.",
    ]);
    expect(s.calls("trial.run")).toEqual([]);
  });

  test("the declaration passes atoll check, and a new atoll's CHARTER.md is the one here", async () => {
    expect(checkSystem(system)).toEqual([]);
    const { s } = await steward(few());
    expect(await s.read("CHARTER.md")).toBe(readFileSync(new URL("../CHARTER.md", import.meta.url), "utf8"));
  });
});

describe("asking GitHub", { timeout: 30_000 }, () => {
  const args: PullArgs = { repo: "tj/commander.js", package: "prettier", version: "3.9.10", from: "3.2.5", section: "devDependencies", save: "--save-dev", head: HEAD, trial: "trial/prettier-3.9.10", branch: "dsk-0000000000111e0a", evidence: ["sha256:aa", "sha256:bb"] };
  const run = system.effects["pr.open"].run!;
  const ctx = { id: "fx9.0", key: "key-for-this-request", now: new Date(START), evidence: () => "sha256:none" };

  /** Run `fn` with GITHUB_API_URL pointing at a local server that handles each request, and GITHUB_TOKEN as given. */
  async function withGitHub<T>(token: string | undefined, handle: (request: IncomingMessage, body: string) => { status: number; body?: string } | "hang up", fn: () => Promise<T>, url?: string): Promise<T> {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const answer = handle(request, body);
        if (answer === "hang up") return request.socket.destroy();
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(answer.body ?? "");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const saved = { token: process.env.GITHUB_TOKEN, url: process.env.GITHUB_API_URL };
    process.env.GITHUB_API_URL = url ?? `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    if (token === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = token;
    try {
      return await fn();
    } finally {
      for (const [name, value] of [["GITHUB_TOKEN", saved.token], ["GITHUB_API_URL", saved.url]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test("sends the repository one repository_dispatch event, with the token only in its header", async () => {
    const seen: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
    const result = await withGitHub("ghp_test_token_0123456789", (request, body) => (seen.push({ method: request.method, url: request.url, headers: request.headers, body }), { status: 204 }), () => Promise.resolve(run(args, ctx)));
    expect(result).toEqual({ requested: true, repo: "tj/commander.js", event: "atoll-upgrade" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/repos/tj/commander.js/dispatches", headers: { authorization: "Bearer ghp_test_token_0123456789", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
    const sent = JSON.parse(seen[0]!.body);
    expect(sent).toEqual({
      event_type: "atoll-upgrade",
      client_payload: { package: "prettier", version: "3.9.10", from: "3.2.5", save: "--save-dev", head: HEAD, trial: "trial/prettier-3.9.10", branch: "dsk-0000000000111e0a", evidence: "sha256:aa sha256:bb", key: "key-for-this-request" },
    });
    // GitHub refuses a client_payload with more than ten top-level properties.
    expect(Object.keys(sent.client_payload).length).toBeLessThanOrEqual(10);
    expect(seen[0]!.body).not.toContain("ghp_test_token_0123456789");
  });

  test("without a token it asks nothing; refused, it says what GitHub said", async () => {
    let requests = 0;
    const count = () => ((requests += 1), { status: 204 });
    expect(await withGitHub(undefined, count, () => Promise.resolve(run(args, ctx)))).toEqual({ requested: false, reason: "GITHUB_TOKEN isn't set where the steward runs" });
    expect(requests).toBe(0);
    const notFound = (await withGitHub("ghp_x", () => ({ status: 404, body: '{"message":"Not Found"}' }), () => Promise.resolve(run(args, ctx)))) as any;
    expect(notFound).toEqual({ requested: false, status: 404, reason: `GitHub answered 404 (the token can't see that repository, or it doesn't exist): {"message":"Not Found"}` });
    const forbidden = (await withGitHub("ghp_x", () => ({ status: 403, body: '{"message":"Resource not accessible by personal access token"}' }), () => Promise.resolve(run(args, ctx)))) as any;
    expect(forbidden.reason).toContain("the token isn't allowed to; it needs write access to the repository's contents");
  });

  test("a request that never connected wasn't received; one that was cut off may have been", async () => {
    // A port that was listening a moment ago and no longer is: the connection is refused.
    const gone = createServer();
    await new Promise<void>((resolve) => gone.listen(0, "127.0.0.1", resolve));
    const closed = `http://127.0.0.1:${(gone.address() as AddressInfo).port}/`;
    await new Promise<void>((resolve) => gone.close(() => resolve()));
    const unreachable = await withGitHub("ghp_x", () => ({ status: 204 }), () => Promise.resolve(run(args, ctx)), closed);
    expect(unreachable).toEqual({ requested: false, reason: "GitHub couldn't be reached" });
    const cut = await withGitHub("ghp_x", () => "hang up", () => Promise.resolve(run(args, ctx)));
    expect(cut).toEqual({ requested: false, inDoubt: true, reason: "GitHub didn't confirm it" });
  });
});

describe("names, versions and flags", () => {
  test.each([
    ["3.9.10", "3.2.5", "minor", true],
    ["3.2.6", "3.2.5", "patch", true],
    ["7.0.2", "5.4.5", "major", true],
    ["3.2.5", "3.2.5", "not-newer", false],
    ["3.0.0", "3.2.5", "not-newer", false],
    ["8.0.0-beta.1", "7.0.2", "prerelease", false],
    ["latest", "1.0.0", "unknown", false],
    ["2.0.0", null, "unknown", false],
  ] as const)("%s when the repository has %s is %s", (version, installed, change, upgrade) => {
    expect(classify(version, installed)).toMatchObject({ change, upgrade });
  });

  test("every package gets an instance name the runtime accepts, however it is spelled", () => {
    const INSTANCE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
    expect(slug("typescript")).toBe("typescript");
    expect(watchAddress("@types/node")).toBe("watch/types__node");
    expect(trialAddress("@types/node", "22.5.0")).toBe("trial/types__node-22.5.0");
    expect(trialAddress("prettier", "4.0.0-alpha.8+build.5")).toBe("trial/prettier-4.0.0-alpha.8_build.5");
    const long = `@some-organisation-with-a-long-name/${"a-package-with-a-long-name-".repeat(3)}x`;
    for (const name of ["typescript", "@types/node", "~tilde", "_private", long, `${long}y`]) expect(slug(name), name).toMatch(INSTANCE);
    // Two long names that differ only at the end still get different instances.
    expect(slug(long)).not.toBe(slug(`${long}y`));
    expect(slug(long)).toHaveLength(64);
  });

  test("npm is told to write the new version the way package.json wrote the old one", () => {
    expect(saveFlags("devDependencies", "^3.2.5")).toBe("--save-dev");
    expect(saveFlags("dependencies", "1.11.0")).toBe("--save-prod --save-exact");
    expect(saveFlags("optionalDependencies", "~2.3.0")).toBe("--save-optional --save-prefix=~");
    expect(saveFlags("dependencies", ">=1 <3")).toBe("--save-prod");
  });

  test("everything that reaches a command is single-quoted", () => {
    const sync = syncCommand({ url: "https://github.com/o/r", ref: "release/1.x", test: "npm run test:unit" }, HEAD);
    expect(sync).toContain("git clone --quiet --depth 1 --branch 'release/1.x' 'https://github.com/o/r' repo");
    expect(sync).toContain("git fetch --quiet --depth 1 origin 'release/1.x'");
    expect(sync).toContain(`if [ "$HEAD_SHA" != '${HEAD}' ]`);
    expect(sync).toContain("( npm run test:unit ) >");
    expect(syncCommand({ url: "https://github.com/o/r", ref: null, test: "npm test" }, null)).toContain("git clone --quiet --depth 1 'https://github.com/o/r' repo");
    expect(syncCommand({ url: "https://github.com/o/r", ref: null, test: "npm test" }, null)).toContain("git fetch --quiet --depth 1 origin 'HEAD'");
    const scoped = trialCommand({ package: "@types/node", version: "22.5.0", section: "devDependencies", spec: "20.12.7" }, "npm test");
    expect(scoped).toContain("npm install --no-audit --no-fund --save-dev --save-exact '@types/node@22.5.0' >");
    // A quote in a value can't end the quoting.
    expect(trialCommand({ package: "x", version: "1'; rm -rf / #", section: "dependencies", spec: "^1.0.0" }, "npm test")).toContain(`'x@1'\\''; rm -rf / #'`);
  });
});

// ---- The two commands, run for real ----------------------------------------------------------------------

describe("the commands, in a shell, against a repository made here", { timeout: 180_000 }, () => {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir() };
  const sh = (cwd: string, command: string): ExecResult => {
    try {
      return { exitCode: 0, stdout: execFileSync("sh", ["-c", command], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
    } catch (error) {
      const failed = error as { status: number | null; stdout: string; stderr: string };
      return { exitCode: failed.status ?? 1, stdout: String(failed.stdout), stderr: String(failed.stderr) };
    }
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Steward Test", "-c", "user.email=steward@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8" }).trim();

  /** A package "dep" at a version, whose answer() is what the repository's one test depends on. */
  function dep(root: string, version: string, source: string): string {
    const dir = join(root, `dep-${version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dep", version, main: "index.js" }));
    writeFileSync(join(dir, "index.js"), source);
    return dir;
  }

  test("sync clones, installs and tests; skips what hasn't changed; and reports tests that fail at head", () => {
    const root = mkdtempSync(join(tmpdir(), "steward-commands-"));
    scratch.push(root);
    const dep1 = dep(root, "1.0.0", "exports.answer = () => 42;\n");
    const dep11 = dep(root, "1.1.0", "exports.answer = () => 42;\nexports.extra = true;\n");
    const dep2 = dep(root, "2.0.0", "exports.reply = () => 42;\n");

    const origin = join(root, "origin");
    mkdirSync(join(origin, "test"), { recursive: true });
    writeFileSync(join(origin, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", private: true, scripts: { test: "node --test" }, devDependencies: { dep: `file:${dep1}` } }, null, 2)}\n`);
    writeFileSync(join(origin, "test", "dep.test.js"), 'const { test } = require("node:test");\nconst assert = require("node:assert");\ntest("the answer", () => assert.strictEqual(require("dep").answer(), 42));\n');
    writeFileSync(join(origin, ".gitignore"), "node_modules\npackage-lock.json\n");
    git(origin, "init", "--quiet", "--initial-branch", "main");
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "A project with one dependency and one test");
    const head = git(origin, "rev-parse", "HEAD");
    const repo = { url: `file://${origin}`, ref: "main", test: "npm test" };

    // The first sync: a clone, an install, and the tests.
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const first = sh(workspace, syncCommand(repo, null));
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    expect(summaryOf(first)).toEqual({ kind: "sync", stage: "done", head, install: "0", test: "0", seconds: expect.any(Number), deps: [{ name: "dep", section: "devDependencies", spec: `file:${dep1}`, installed: "1.0.0" }] });

    // Nothing changed, and those tests are on record: nothing is installed and nothing runs.
    expect(summaryOf(sh(workspace, syncCommand(repo, head)))).toMatchObject({ head, install: "skipped", test: "skipped" });

    // ---- trials, each on a copy of the workspace, as a branch of the disk is ---------------------------
    const tryOn = (name: string, target: string) => {
      const branch = join(root, name);
      cpSync(workspace, branch, { recursive: true, verbatimSymlinks: true });
      return sh(branch, trialCommand({ package: "dep", version: `file:${target}`, section: "devDependencies", spec: "^1.0.0" }, "npm test"));
    };
    const passes = tryOn("branch-passes", dep11);
    expect(passes.exitCode, passes.stdout + passes.stderr).toBe(0);
    expect(summaryOf(passes)).toEqual({ kind: "trial", stage: "test", head, installed: "1.1.0", install: 0, test: 0, installSeconds: expect.any(Number), testSeconds: expect.any(Number), changed: ["package.json"] });

    const breaks = tryOn("branch-breaks", dep2);
    expect(breaks.exitCode).toBe(1);
    expect(summaryOf(breaks)).toMatchObject({ stage: "test", installed: "2.0.0", install: 0, test: 1, changed: ["package.json"] });
    expect(breaks.stdout).toContain("answer is not a function");

    // A tarball that isn't there, which npm refuses as it refuses a version the registry doesn't have.
    const missing = tryOn("branch-missing", join(root, "dep-9.9.9.tgz"));
    expect(missing.exitCode, missing.stdout + missing.stderr).toBe(91);
    expect(summaryOf(missing)).toMatchObject({ stage: "install", installed: "1.0.0", test: null, changed: [] });

    // None of that touched the workspace the trials were copied from.
    expect(JSON.parse(readFileSync(join(workspace, "repo", "node_modules", "dep", "package.json"), "utf8")).version).toBe("1.0.0");
    expect(git(join(workspace, "repo"), "status", "--porcelain")).toBe("");

    // ---- upstream breaks its own test: the sync reports it as a reading, and exits 0 ------------------
    writeFileSync(join(origin, "test", "dep.test.js"), 'const { test } = require("node:test");\nconst assert = require("node:assert");\ntest("the answer", () => assert.strictEqual(require("dep").answer(), 41));\n');
    git(origin, "commit", "--quiet", "-am", "Expect the wrong answer");
    const moved = git(origin, "rev-parse", "HEAD");
    const red = sh(workspace, syncCommand(repo, head));
    expect(red.exitCode, red.stdout + red.stderr).toBe(0);
    // package.json didn't change, so nothing is installed again; the commit did, so the tests run.
    expect(summaryOf(red)).toMatchObject({ head: moved, install: "skipped", test: "1" });

    // ---- a repository that isn't there ------------------------------------------------------------------
    const nowhere = join(root, "elsewhere");
    mkdirSync(nowhere);
    const lost = sh(nowhere, syncCommand({ url: `file://${join(root, "no-such-repository")}`, ref: null, test: "npm test" }, null));
    expect(lost.exitCode).toBe(91);
    expect(summaryOf(lost)).toEqual({ kind: "sync", stage: "git" });
    expect(lost.stdout).toContain("no-such-repository");
  });
});
