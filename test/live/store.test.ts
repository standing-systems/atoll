// ArchilStore against the real service: the Store contract, scoped hands, and snapshots, on one fresh
// disk that is deleted afterwards. Opt in with ATOLL_LIVE=1 and Archil credentials in the environment.
// Costs about 6 exec calls; the ledger (test/live/live.ts) counts them.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArchilStore } from "../../src/store/archil.ts";
import { asText } from "../../src/store/types.ts";
import { storeConformance } from "../store/conformance.ts";
import { countExec, createLiveDisk, LIVE, suffix, type LiveDisk } from "./live.ts";

describe.skipIf(!LIVE)("ArchilStore live", () => {
  let live: LiveDisk;
  let store: ArchilStore;
  beforeAll(async () => {
    live = await createLiveDisk("store");
    store = live.store;
  }, 60_000);
  afterAll(async () => {
    await live?.cleanup();
  }, 60_000);

  storeConformance("ArchilStore", () => store, { timeout: 60_000 });
  // The same contract for an atoll rooted at a prefix, sharing the disk: object-API calls only.
  storeConformance("ArchilStore under a prefix", () => ArchilStore.open({ disk: live.disk.id, archil: live.archil, prefix: "atolls/second" }), { timeout: 60_000 });

  describe("hands", () => {
    it("scopes exec to workspace/: writes reach the object API, and .atoll/ is out of reach", async () => {
      await store.put("workspace/seed.txt", "seed\n");
      await store.put(".atoll/secret.txt", "do not read\n");
      countExec("live: scoped exec");
      const out = await store.exec({
        scope: "workspace",
        command: [
          'echo "pwd=$(pwd)"',
          "cat seed.txt",
          "echo made > made.txt",
          "echo gone > gone.txt && rm gone.txt && echo rm-ok",
          "mkdir -p sub && mv made.txt sub/moved.txt && cp sub/moved.txt made.txt && echo mv-ok",
          'echo "parent=[$(ls -A .. | tr "\\n" " ")]"',
          "if cat ../.atoll/secret.txt 2>/dev/null || cat /mnt/archil/.atoll/secret.txt 2>/dev/null; then echo LEAK; else echo atoll-hidden; fi",
        ].join("\n"),
      });
      expect(out.exitCode, out.stderr).toBe(0);
      expect(out.stdout).toContain("pwd=/mnt/archil/s\n");
      expect(out.stdout).toContain("seed\n");
      expect(out.stdout).toContain("rm-ok\n");
      expect(out.stdout).toContain("mv-ok\n");
      expect(out.stdout).toContain("parent=[s ]");
      expect(out.stdout).toContain("atoll-hidden\n");
      expect(out.stdout).not.toContain("LEAK");
      expect(out.timing?.totalMs).toBeGreaterThan(0);
      expect(asText(await store.get("workspace/made.txt"))).toBe("made\n");
      expect(asText(await store.get("workspace/sub/moved.txt"))).toBe("made\n");
      expect(await store.get("workspace/gone.txt")).toBeNull();
      expect(asText(await store.get(".atoll/secret.txt"))).toBe("do not read\n");
    }, 60_000);

    it("makes read-only exec unable to write", async () => {
      countExec("live: read-only exec");
      const out = await store.exec({ scope: "workspace", readOnly: true, command: "cat seed.txt\ntouch nope.txt" });
      expect(out.exitCode).not.toBe(0);
      expect(out.stdout).toBe("seed\n");
      expect(out.stderr).toMatch(/Read-only file system/);
      expect(await store.get("workspace/nope.txt")).toBeNull();
    }, 60_000);
  });

  describe("snapshots", () => {
    const tag = suffix();
    const checkpoint = `cp-${tag}`;

    it("checkpoints, reads as of the checkpoint, and branches into an independent store", async () => {
      await store.put("notes/a.txt", "v1");
      await store.put("notes/gone-later.txt", "here at the checkpoint");
      await store.append("notes/log.txt", "one\n");
      countExec("live: checkpoint");
      await store.checkpoint(checkpoint);
      await store.put("notes/a.txt", "v2");
      await store.put("notes/b.txt", "after the checkpoint");
      await store.delete("notes/gone-later.txt");
      await store.append("notes/log.txt", "two\n");

      expect(asText(await store.readAt(checkpoint, "notes/a.txt"))).toBe("v1");
      expect(asText(await store.readAt(checkpoint, "notes/gone-later.txt"))).toBe("here at the checkpoint");
      expect(asText(await store.readAt(checkpoint, "notes/log.txt"))).toBe("one\n");
      expect(await store.readAt(checkpoint, "notes/b.txt")).toBeNull();
      await expect(store.readAt(`cp-never-${tag}`, "notes/a.txt")).rejects.toThrow(/No checkpoint named/);

      const branch = await store.branch(`br-${tag}`, checkpoint);
      expect(branch).toEqual({ id: expect.stringMatching(/^dsk-[0-9a-f]+$/), name: `br-${tag}` });
      expect(await store.branch(`br-${tag}`, checkpoint)).toEqual(branch);

      const copy = await store.open(branch.id);
      expect(copy.location).toBe(`archil:${branch.id}`);
      expect(asText(await copy.get("notes/a.txt"))).toBe("v1");
      expect(asText(await copy.get("notes/log.txt"))).toBe("one\n");
      expect(await copy.get("notes/b.txt")).toBeNull();
      await copy.put("notes/c.txt", "branch only");
      await copy.append("notes/log.txt", "branch\n");
      expect(await store.get("notes/c.txt")).toBeNull();
      expect(asText(await store.get("notes/log.txt"))).toBe("one\ntwo\n");
      await store.put("notes/d.txt", "main only");
      expect(await copy.get("notes/d.txt")).toBeNull();

      countExec("live: exec on a branch store");
      const onCopy = await copy.exec({ scope: "notes", command: "cat a.txt c.txt" });
      expect(onCopy).toMatchObject({ exitCode: 0, stdout: "v1branch only" });
      countExec("live: exec with request.disk = branch");
      const viaDisk = await store.exec({ disk: branch.id, scope: "notes", readOnly: true, command: "cat log.txt" });
      expect(viaDisk).toMatchObject({ exitCode: 0, stdout: "one\nbranch\n" });
    }, 180_000);

    it("refuses to reuse a checkpoint name", async () => {
      countExec("live: duplicate checkpoint");
      await expect(store.checkpoint(checkpoint)).rejects.toThrow(/already exists/);
    }, 60_000);
  });
});
