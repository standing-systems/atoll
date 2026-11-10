// Release radar against npm's real history. The fixtures are npm's own replies for rivetkit and disk,
// fetched on 5 November 2026 at 04:38 UTC and trimmed to the fields used: `<name>-latest.json` from
// https://registry.npmjs.org/<name>/latest (the URL the watch calls), and `<name>.json` from
// https://registry.npmjs.org/<name> (the publish time of each stable version since 1 October). The stub
// answers as npm would have at the test clock's time, so every version and date below really happened.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { checkAtoll, checkSystem } from "@standing-systems/atoll";
import { testAtoll } from "@standing-systems/atoll/testing";
import system, { classify, latestUrl } from "../system.ts";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;

interface Packument {
  name: string;
  "dist-tags": { latest: string };
  time: Record<string, string>;
}

const packuments: Record<string, Packument> = { rivetkit: fixture("rivetkit.json"), disk: fixture("disk.json") };
const latestReplies: Record<string, { name: string; version: string }> = {
  rivetkit: fixture("rivetkit-latest.json"),
  disk: fixture("disk-latest.json"),
};

/** npm's registry as it was at `now`: the newest stable version published by then is `latest`. */
class Registry {
  now: Date;
  /** Packages whose requests fail, and the status npm answers them with. */
  readonly failing = new Map<string, number>();

  constructor(now: string) {
    this.now = new Date(now);
  }

  latest(name: string): string | null {
    let found: [string, string] | null = null;
    for (const [version, at] of Object.entries(packuments[name]?.time ?? {})) {
      if (new Date(at) <= this.now && (!found || at > found[1])) found = [version, at];
    }
    return found?.[0] ?? null;
  }

  /** The npm.get stub. A stub's answer skips the runtime's `pick`, so it answers with the picked fields. */
  readonly get = (args: { url: string }) => {
    const name = decodeURIComponent(new URL(args.url).pathname.split("/")[1] ?? "");
    const failing = this.failing.get(name);
    if (failing) return { status: failing, text: "Service Unavailable" };
    const version = this.latest(name);
    const reply = latestReplies[name];
    if (!version || !reply) return { status: 404, json: "Not Found" };
    return { status: 200, json: { ...reply, version } };
  };
}

type Atoll = Awaited<ReturnType<typeof testAtoll>>;
const open: Atoll[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/** A radar watching rivetkit and disk from Monday 26 October 2026, 17:00 UTC, with npm as it was then. */
async function radar(start = "2026-10-26T17:00:00.000Z") {
  const npm = new Registry(start);
  const s = await testAtoll(system, { now: start, stubs: { "npm.get": npm.get } });
  open.push(s);
  await s.send("watch/rivetkit", "watch.start", { package: "rivetkit" });
  await s.send("watch/disk", "watch.start", { package: "disk" });
  await s.tick();
  /** Move the clock, and npm with it, to `at`; then tick, as an outside clock would. */
  const advanceTo = async (at: string) => {
    const ms = new Date(at).getTime() - npm.now.getTime();
    npm.now = new Date(at);
    await s.advance(`${ms}ms`);
  };
  return { s, npm, advanceTo };
}

/** Everything the atoll has told me, oldest first. */
async function told(s: Atoll): Promise<string[]> {
  return (await s.journal()).flatMap((r) => (r.kind === "turn" ? r.notices.map((n) => n.text) : []));
}

/** The ledger's release files, by name. */
async function releases(s: Atoll): Promise<string[]> {
  return (await s.list("parts/ledger/releases/")).map((key) => key.slice(key.lastIndexOf("releases/") + "releases/".length)).sort();
}

// Each test ticks an atoll on disk many times; a busy machine can take longer than vitest's default 5 s.
describe("release radar", { timeout: 60_000 }, () => {
  test("the first reading of each package is a baseline: recorded, not told", async () => {
    // Where a package stands when I start watching it isn't news (rivetkit 2.3.30 was three weeks
    // old), so the ledger records it as a baseline to compare the next release with, and says nothing.
    const { s } = await radar();
    expect(s.calls("npm.get").map((c) => c.args).sort((a, b) => a.url.localeCompare(b.url))).toEqual([
      { url: latestUrl("disk"), pick: ["name", "version"] },
      { url: latestUrl("rivetkit"), pick: ["name", "version"] },
    ]);
    expect(await s.json("parts/watch/rivetkit/latest.json")).toMatchObject({ version: "2.3.30", previous: null });
    expect(await s.json("parts/watch/disk/latest.json")).toMatchObject({ version: "1.9.0", previous: null });
    expect(await s.json("parts/ledger/releases/rivetkit@2.3.30.json")).toMatchObject({ change: "first", significant: false, told: false });
    expect(await s.json("parts/ledger/releases/disk@1.9.0.json")).toMatchObject({ change: "first", significant: false, told: false });
    expect(await told(s)).toEqual([]);
  });

  test("a new minor version is told once", async () => {
    const { s, advanceTo } = await radar();
    await advanceTo("2026-10-27T20:00:00.000Z"); // disk 1.10.0 was published at 19:58
    expect(await s.json("parts/ledger/releases/disk@1.10.0.json")).toMatchObject({ change: "minor", significant: true, previous: "1.9.0", told: true });
    expect(await told(s)).toEqual(["disk 1.10.0 is out: a minor release after 1.9.0. https://www.npmjs.com/package/disk/v/1.10.0"]);
    await advanceTo("2026-10-27T21:00:00.000Z"); // npm still says 1.10.0
    await advanceTo("2026-10-28T09:00:00.000Z");
    expect(await told(s)).toHaveLength(1);
  });

  test("a patch is recorded but not told", async () => {
    const { s, advanceTo } = await radar();
    await advanceTo("2026-10-27T22:00:00.000Z"); // rivetkit 2.3.31 was published at 21:40
    expect(await s.json("parts/ledger/releases/rivetkit@2.3.31.json")).toMatchObject({ change: "patch", significant: false, previous: "2.3.30", told: false });
    expect(await s.json("parts/ledger/latest.json")).toMatchObject({ rivetkit: { version: "2.3.31" } });
    expect((await told(s)).filter((text) => text.includes("rivetkit"))).toEqual([]);
  });

  test("a major version is told once, even when the clock slept through a release", async () => {
    const { s, advanceTo } = await radar();
    await advanceTo("2026-10-28T09:00:00.000Z"); // 2.3.31, a patch
    // Nothing ticks until Wednesday 4 November. Meanwhile rivetkit published 3.0.0, then 3.0.1.
    await advanceTo("2026-11-04T09:00:00.000Z");
    expect(await s.json("parts/ledger/releases/rivetkit@3.0.0.json")).toBeNull();
    expect(await s.json("parts/ledger/releases/rivetkit@3.0.1.json")).toMatchObject({ change: "major", previous: "2.3.31", told: true });
    expect((await told(s)).filter((text) => text.startsWith("rivetkit"))).toEqual([
      "rivetkit 3.0.1 is out: a major release after 2.3.31. https://www.npmjs.com/package/rivetkit/v/3.0.1",
    ]);
  });

  test("a duplicate release.seen doesn't double-count", async () => {
    const { s, advanceTo } = await radar();
    await advanceTo("2026-10-27T20:00:00.000Z"); // disk 1.10.0
    const recorded = await s.json("parts/ledger/releases/disk@1.10.0.json");
    const pointers = await s.json("parts/ledger/latest.json");
    // The same release again, as a second watch on disk or a hand-sent event would report it.
    await s.send("ledger", "release.seen", { name: "disk", version: "1.10.0", seenAt: "2026-10-27T20:30:00.000Z" });
    await s.tick();
    expect(await s.json("parts/ledger/releases/disk@1.10.0.json")).toEqual(recorded);
    expect(await s.json("parts/ledger/latest.json")).toEqual(pointers);
    expect((await releases(s)).filter((name) => name.startsWith("disk@"))).toEqual(["disk@1.10.0.json", "disk@1.9.0.json"]);
    expect((await told(s)).filter((text) => text.startsWith("disk 1.10.0"))).toHaveLength(1);
  });

  test("an older version reported late is recorded, without moving the pointer or telling me", async () => {
    const { s, advanceTo } = await radar();
    await advanceTo("2026-10-27T20:00:00.000Z"); // disk 1.10.0
    await s.send("ledger", "release.seen", { name: "disk", version: "1.8.0" });
    await s.tick();
    expect(await s.json("parts/ledger/releases/disk@1.8.0.json")).toMatchObject({ change: "older", significant: false });
    expect(await s.json("parts/ledger/latest.json")).toMatchObject({ disk: { version: "1.10.0" } });
    expect((await told(s)).filter((text) => text.includes("1.8.0"))).toEqual([]);
  });

  test("a registry failure is recorded without changing what the watch knows, and the next poll recovers", async () => {
    const { s, npm, advanceTo } = await radar();
    await advanceTo("2026-10-28T09:00:00.000Z"); // rivetkit 2.3.31
    const knows = await s.json("parts/watch/rivetkit/latest.json");
    npm.failing.set("rivetkit", 500);
    await advanceTo("2026-11-01T11:00:00.000Z"); // 3.0.0 came out at 10:58, but npm answers 500
    expect(await s.json("parts/watch/rivetkit/latest.json")).toEqual(knows);
    expect(await s.json("parts/watch/rivetkit/health.json")).toMatchObject({ failures: 1, lastError: "HTTP 500" });
    expect(await s.json("parts/ledger/releases/rivetkit@3.0.0.json")).toBeNull();
    const notes = (await s.journal()).flatMap((r) => (r.kind === "turn" && r.part === "watch/rivetkit" && r.note ? [r.note] : []));
    expect(notes.at(-1)).toBe("Couldn't read rivetkit from npm (HTTP 500): 1 failed check in a row. What it knows is unchanged.");
    expect((await told(s)).filter((text) => text.includes("rivetkit"))).toEqual([]);

    npm.failing.delete("rivetkit");
    await advanceTo("2026-11-01T12:00:00.000Z");
    expect(await s.json("parts/watch/rivetkit/health.json")).toBeNull();
    expect(await s.json("parts/watch/rivetkit/latest.json")).toMatchObject({ version: "3.0.0", previous: "2.3.31" });
    expect((await told(s)).filter((text) => text.startsWith("rivetkit"))).toEqual([
      "rivetkit 3.0.0 is out: a major release after 2.3.31. https://www.npmjs.com/package/rivetkit/v/3.0.0",
    ]);
  });

  test("three failed checks in a row are told once, and so is reading npm again", async () => {
    const { s, npm, advanceTo } = await radar();
    npm.failing.set("disk", 503);
    for (const hour of [18, 19, 20, 21]) await advanceTo(`2026-10-26T${hour}:00:00.000Z`);
    expect(await s.json("parts/watch/disk/health.json")).toMatchObject({ failures: 4, lastError: "HTTP 503" });
    expect(await told(s)).toEqual(["I couldn't read disk from npm the last 3 times I checked, most recently: HTTP 503. I'll keep checking every hour."]);
    npm.failing.delete("disk");
    await advanceTo("2026-10-26T22:00:00.000Z");
    expect(await s.json("parts/watch/disk/health.json")).toBeNull();
    expect((await told(s)).slice(1)).toEqual(["I can read disk from npm again, after 4 failed checks."]);
  });

  test("the Monday digest lists the week's releases", async () => {
    const { s, advanceTo } = await radar(); // Monday 26 October, 17:00 UTC
    for (const at of ["2026-10-27T20:00:00.000Z", "2026-10-27T22:00:00.000Z", "2026-11-01T11:00:00.000Z", "2026-11-02T16:00:00.000Z"]) {
      await advanceTo(at);
    }
    const digest = await s.read("parts/digest/digests/2026-11-02.md");
    expect(digest).toBe(
      [
        "# Releases, week ending Monday, November 2",
        "",
        "2 major or minor releases and 1 patch, recorded between Monday, October 26 at 16:00 and Monday, November 2 at 16:00 UTC.",
        "",
        "## Major and minor releases",
        "",
        "- disk 1.10.0, a minor release after 1.9.0 (Tuesday, October 27 at 20:00 UTC)",
        "- rivetkit 3.0.0, a major release after 2.3.31 (Sunday, November 1 at 11:00 UTC)",
        "",
        "## Patches",
        "",
        "- rivetkit 2.3.31, a patch after 2.3.30 (Tuesday, October 27 at 22:00 UTC)",
        "",
        "## Started watching",
        "",
        "- disk at 1.9.0",
        "- rivetkit at 2.3.30",
        "",
        "## Watching",
        "",
        "- disk 1.10.0",
        "- rivetkit 3.0.0",
        "",
      ].join("\n"),
    );
    expect((await told(s)).at(-1)).toBe(digest);

    // A report that arrives just after this digest, about something seen just before it, goes in the next.
    await s.send("ledger", "release.seen", { name: "rivetkit", version: "2.3.29", seenAt: "2026-11-02T15:59:00.000Z" });
    await s.tick();

    // The next digest starts where this one ended, and ends where the real replies were fetched.
    for (const at of ["2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z", "2026-11-05T03:00:00.000Z", "2026-11-09T16:00:00.000Z"]) {
      await advanceTo(at);
    }
    const next = await s.read("parts/digest/digests/2026-11-09.md");
    expect(next).toContain("2 patches");
    expect(next).toContain("- disk 1.11.0, a minor release after 1.10.0 (Tuesday, November 3 at 00:00 UTC)");
    expect(next).toContain("- rivetkit 3.0.1, a patch after 3.0.0 (Wednesday, November 4 at 00:00 UTC)");
    expect(next).toContain("- rivetkit 3.0.2, a patch after 3.0.1 (Thursday, November 5 at 03:00 UTC)");
    expect(next).toContain(`- rivetkit ${latestReplies.rivetkit?.version}\n`);
    expect(next).toContain(`- disk ${latestReplies.disk?.version}\n`);
    expect(next).toContain("- rivetkit 2.3.29, not newer than 3.0.0, which is already recorded (Monday, November 2 at 15:59 UTC)");
    expect(next).not.toContain("disk 1.10.0,");
    expect(next).not.toContain("Started watching");

    // After two weeks: no idle part, no unhandled wait, and every file under parts/ came from a turn.
    expect(await checkAtoll(s.store, system)).toEqual([]);
  });

  test("status shows each watch waiting on its schedule", async () => {
    const { s } = await radar();
    const status = await s.status();
    const of = (address: string) => status.waiting.find((w) => w.address === address);
    for (const address of ["watch/rivetkit", "watch/disk"]) {
      expect(of(address)).toMatchObject({ status: "waiting", waits: [expect.objectContaining({ schedule: expect.any(Number), until: "2026-10-26T18:00:00.000Z" })] });
    }
    expect(of("ledger")).toMatchObject({ status: "waiting", waits: [expect.objectContaining({ for: "release.seen" })] });
    expect(of("digest")).toMatchObject({ status: "waiting", waits: [expect.objectContaining({ until: "2026-11-02T16:00:00.000Z" })] });
    expect(status.idle).toEqual([]);
  });

  test("the declaration passes atoll check, and a new atoll's CHARTER.md is the one here", async () => {
    expect(checkSystem(system)).toEqual([]);
    const { s } = await radar();
    expect(await s.read("CHARTER.md")).toBe(readFileSync(new URL("../CHARTER.md", import.meta.url), "utf8"));
  });

  test("the replay ends where npm's real replies were fetched", () => {
    const fetched = new Registry("2026-11-05T04:38:25.000Z");
    for (const name of ["rivetkit", "disk"]) {
      expect(fetched.latest(name)).toBe(latestReplies[name]?.version);
      expect(fetched.latest(name)).toBe(packuments[name]?.["dist-tags"].latest);
    }
  });
});

describe("classify", () => {
  test.each([
    ["3.0.0", "2.3.31", "major", true],
    ["2.4.0", "2.3.31", "minor", true],
    ["2.4.1", "2.3.31", "minor", true], // a minor and its first patch, between two checks
    ["2.3.32", "2.3.31", "patch", false],
    ["3.0.0-rc.1", "2.3.31", "prerelease", false],
    ["2.3.30", "2.3.31", "older", false],
    ["1.0.0", null, "first", false],
    ["latest", "1.0.0", "unknown", false],
  ] as const)("%s after %s is %s", (version, previous, change, significant) => {
    expect(classify(version, previous)).toMatchObject({ change, significant });
  });
});
