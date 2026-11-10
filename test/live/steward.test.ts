// The upgrade steward on a real disk, against a real repository: tj/commander.js at its v12.1.0 tag, a
// public project with 15 development dependencies, a lockfile, and 1,104 tests.
//
// The steward clones it in a microVM, installs its dependencies onto the disk, and runs its tests. Then
// three versions are tried, each on a branch of the whole disk: one that passes the tests, one that
// breaks them, and one that doesn't exist. The test looks at the branches afterwards: each holds the
// package the trial installed, and the main checkout still holds the old one.
//
// npm is stubbed, and only npm: it answers with the two versions below for prettier and typescript and
// with the installed version for every other dependency, so the same two trials run whatever has been
// published since. Everything else is real: git, the registry the microVMs install from, the tests.
//
// Opt in with ATOLL_LIVE=1. Costs nine exec calls (two syncs, a checkpoint and a command for each of
// three trials, and one more sync) and one disk, deleted afterwards with its branches. It takes about six
// minutes, most of it the repository's own test suite running four times.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import system, { trialAddress, type Dep } from "../../examples/upgrade-steward/system.ts";
import { testAtoll, type TestAtoll } from "../../src/testing.ts";
import { asText } from "../../src/store/types.ts";
import { countExec, createLiveDisk, LIVE, note, type LiveDisk } from "./live.ts";

const REPO = "https://github.com/tj/commander.js";
const TAG = "v12.1.0";
const HEAD = "970ecae402b253de691e6a9066fea22f38fe7431";
/** What npm "calls latest" here: a minor release the tests pass with, and a major one they don't. */
const LATEST: Record<string, string> = { prettier: "3.9.10", typescript: "7.0.2" };

describe.skipIf(!LIVE)("the upgrade steward on Archil", () => {
  let live: LiveDisk;
  let s: TestAtoll;
  let savedToken: string | undefined;

  const json = async <T>(path: string): Promise<T> => JSON.parse(asText(await live.store.get(path)) ?? "null") as T;
  const notices = async (): Promise<string[]> => Promise.all((await s.list("notices/")).map(async (path) => (await s.read(path)) ?? ""));
  const versionOn = async (disk: string, name: string): Promise<string> => {
    const store = await live.store.open(disk);
    return (JSON.parse(asText(await store.get(`workspace/repo/node_modules/${name}/package.json`)) ?? "{}") as { version: string }).version;
  };

  beforeAll(async () => {
    savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    live = await createLiveDisk("steward");
    const npm = async (args: { url: string }) => {
      const name = decodeURIComponent(new URL(args.url).pathname.split("/")[1] ?? "");
      const installed = (await json<Dep[] | null>("parts/repo/deps.json"))?.find((d) => d.name === name)?.installed ?? null;
      return { status: 200, json: { name, version: LATEST[name] ?? installed } };
    };
    s = await testAtoll(system, { store: live.store, hands: live.store, snapshots: live.store, realEffects: true, now: new Date(), stubs: { "npm.get": npm } });
  }, 120_000);

  afterAll(async () => {
    if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
    await s?.close();
    await live?.cleanup();
  }, 120_000);

  it("keeps a real repository, tries three upgrades on branches, and asks before a pull request", async () => {
    // ---- the checkout, and two trials --------------------------------------------------------------
    for (const label of ["first sync", "checkpoint for typescript", "trial of typescript", "checkpoint for prettier", "trial of prettier"]) countExec(`steward: ${label}`);
    s.setNow(new Date());
    await s.send("repo", "repo.track", { url: REPO, ref: TAG });
    let started = Date.now();
    await s.tick();
    const firstMs = Date.now() - started;

    const repo = await json<{ github: string; head: string; baseline: { head: string; passed: boolean; seconds: number } }>("parts/repo/repo.json");
    expect(repo).toMatchObject({ github: "tj/commander.js", head: HEAD, baseline: { head: HEAD, passed: true } });
    const deps = await json<Dep[]>("parts/repo/deps.json");
    expect(deps).toHaveLength(15);
    expect(deps.find((d) => d.name === "typescript")).toEqual({ name: "typescript", section: "devDependencies", spec: "^5.0.4", installed: "5.4.5" });
    expect(deps.find((d) => d.name === "prettier")).toMatchObject({ spec: "^3.2.5", installed: "3.2.5" });
    // One watch per dependency, a scoped name included.
    expect((await s.list("parts/watch/")).filter((p) => p.endsWith("/watch.json"))).toHaveLength(15);
    expect(await json<Dep>("parts/watch/types__node/watch.json")).toMatchObject({ name: "@types/node", installed: "20.12.7" });

    const broke = await json<any>("parts/trial/typescript-7.0.2/trial.json");
    const safe = await json<any>("parts/trial/prettier-3.9.10/trial.json");
    expect(broke).toMatchObject({ state: "failed", change: "major", from: "5.4.5", head: HEAD, changed: ["package-lock.json", "package.json"], pull: null });
    expect(safe).toMatchObject({ state: "passed", change: "minor", from: "3.2.5", head: HEAD, changed: ["package-lock.json", "package.json"], pull: { state: "asked" } });
    expect(broke.branch).toMatch(/^dsk-/);
    expect(safe.branch).toMatch(/^dsk-/);
    expect(new Set([broke.branch, safe.branch, live.disk.id]).size).toBe(3);

    // Each branch holds the checkout its trial left; the main disk still has what the repository has.
    expect(await versionOn(broke.branch, "typescript")).toBe("7.0.2");
    expect(await versionOn(safe.branch, "prettier")).toBe("3.9.10");
    expect(await versionOn(safe.branch, "typescript")).toBe("5.4.5");
    expect(await versionOn(live.disk.id, "typescript")).toBe("5.4.5");
    expect(await versionOn(live.disk.id, "prettier")).toBe("3.2.5");
    expect(JSON.parse(asText(await live.store.get("workspace/repo/package.json"))!).devDependencies.prettier).toBe("^3.2.5");
    const onBranch = await live.store.open(safe.branch);
    expect(JSON.parse(asText(await onBranch.get("workspace/repo/package.json"))!).devDependencies.prettier).toBe("^3.9.10");

    let told = await notices();
    expect(told.filter((n) => n.includes("typescript 7.0.2 breaks tj/commander.js at 970ecae"))).toHaveLength(1);
    expect(told.filter((n) => n.includes("prettier 3.9.10 is safe for tj/commander.js at 970ecae"))).toHaveLength(1);
    expect(told.find((n) => n.includes("typescript 7.0.2 breaks"))).toContain(broke.branch);
    expect(await s.read("parts/trial/typescript-7.0.2/output.txt")).toContain("FAIL");

    // ---- a version that doesn't exist ----------------------------------------------------------------
    for (const label of ["checkpoint for a missing version", "trial of a missing version"]) countExec(`steward: ${label}`);
    s.setNow(new Date());
    await s.send(trialAddress("prettier", "99.99.99"), "trial.start", { package: "prettier", version: "99.99.99" });
    started = Date.now();
    await s.tick();
    const missingMs = Date.now() - started;
    const missing = await json<any>("parts/trial/prettier-99.99.99/trial.json");
    expect(missing).toMatchObject({ state: "not-installable", from: "3.2.5", change: "major", pull: null });
    expect(missing.branch).toMatch(/^dsk-/);
    told = await notices();
    expect(told.filter((n) => n.includes("I couldn't install prettier 99.99.99 into tj/commander.js"))).toHaveLength(1);

    // ---- only the passing one asks, and nothing is sent without a token --------------------------------
    const asks = await s.asks();
    expect(asks).toHaveLength(1);
    expect(asks[0]!.question).toBe("Ask GitHub to open a pull request on tj/commander.js that upgrades prettier from 3.2.5 to 3.9.10, whose tests passed on a copy at 970ecae?");
    expect(asks[0]!.payload).toMatchObject({ repo: "tj/commander.js", package: "prettier", version: "3.9.10", save: "--save-dev", head: HEAD, branch: safe.branch });
    s.setNow(new Date());
    await s.answer(asks[0]!.id, "approve");
    expect((await json<any>("parts/trial/prettier-3.9.10/trial.json")).pull).toMatchObject({ state: "not-requested", detail: "GITHUB_TOKEN isn't set where the steward runs" });
    expect((await notices()).some((n) => n.includes("To make the change yourself: npm install --save-dev prettier@3.9.10"))).toBe(true);

    // ---- nothing new upstream: the next sync installs nothing and runs no tests ---------------------------
    countExec("steward: second sync");
    s.setNow(new Date());
    await s.send("repo", "repo.sync", {});
    started = Date.now();
    await s.tick();
    const againMs = Date.now() - started;
    const results = (await s.journal()).filter((r) => r.kind === "effect" && (r as any).deliver && ["repo.sync", "trial.run", "pr.open"].includes((r as any).name)) as any[];
    const lastSync = results.filter((r) => r.name === "repo.sync").at(-1).deliver.body.result.stdout as string;
    expect(lastSync).toContain('"install":"skipped","test":"skipped"');
    expect((await s.status()).counts.branches).toBe(3);
    expect(await s.asks()).toEqual([]);

    const summary = {
      ms: { first: firstMs, missing: missingMs, again: againMs },
      baselineSeconds: repo.baseline.seconds,
      seconds: { typescript: broke.seconds, prettier: safe.seconds, missing: missing.seconds },
      branches: { typescript: broke.branch, prettier: safe.branch, missing: missing.branch },
      // What each effect answered, for the fixtures the offline tests replay.
      results: results.map((r) => ({ name: r.name, state: r.state, body: r.deliver.body })),
    };
    note("steward", summary);
    console.log(`[steward] ${JSON.stringify({ ...summary, results: summary.results.map((r) => `${r.name}:${r.state}`) })}`);
  }, 900_000);
});
