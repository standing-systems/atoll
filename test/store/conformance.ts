// The behavior every Store must have, as one vitest suite. test/store/local.test.ts runs it on a
// directory and test/live/store.test.ts on an Archil disk, so the runner can rely on the same contract
// wherever an atoll lives. Each test works under its own key prefix, so one store serves the whole suite.

import { beforeAll, describe, expect, it } from "vitest";
import { asText, type Store } from "../../src/store/types.ts";

export interface ConformanceOptions {
  /** Per-test timeout in milliseconds (a live store needs more than the default). */
  timeout?: number;
  /** Prefix for every key the suite writes (default "conformance"). */
  root?: string;
}

const text = (bytes: Uint8Array | null) => asText(bytes);

export function storeConformance(name: string, makeStore: () => Store | Promise<Store>, options: ConformanceOptions = {}): void {
  const timeout = options.timeout ?? 10_000;
  const root = options.root ?? "conformance";

  describe(`Store conformance: ${name}`, () => {
    let store: Store;
    beforeAll(async () => {
      store = await makeStore();
    }, timeout);

    it("puts, gets, and overwrites objects", async () => {
      const key = `${root}/put/a/b.txt`;
      await store.put(key, "one");
      expect(text(await store.get(key))).toBe("one");
      await store.put(key, "two, longer than one");
      expect(text(await store.get(key))).toBe("two, longer than one");
      await store.put(key, "3");
      expect(text(await store.get(key))).toBe("3");
    }, timeout);

    it("round-trips binary and empty bodies", async () => {
      const bytes = new Uint8Array(256).map((_, i) => i);
      await store.put(`${root}/bytes/all.bin`, bytes);
      expect(Array.from((await store.get(`${root}/bytes/all.bin`))!)).toEqual(Array.from(bytes));
      await store.put(`${root}/bytes/empty`, "");
      const empty = await store.get(`${root}/bytes/empty`);
      expect(empty).not.toBeNull();
      expect(empty!.byteLength).toBe(0);
    }, timeout);

    it("returns null for missing objects", async () => {
      expect(await store.get(`${root}/missing/nothing.txt`)).toBeNull();
      expect(await store.get(`${root}/missing/deeper/still/nothing.txt`)).toBeNull();
      expect(await store.head(`${root}/missing/nothing.txt`)).toBeNull();
    }, timeout);

    it("creates only when nothing exists", async () => {
      const key = `${root}/create/once.json`;
      expect(await store.create(key, "first")).toBe(true);
      expect(await store.create(key, "second")).toBe(false);
      expect(text(await store.get(key))).toBe("first");
      expect(await store.create(`${root}/create/empty`, "")).toBe(true);
      expect((await store.get(`${root}/create/empty`))!.byteLength).toBe(0);
    }, timeout);

    it("gives exactly one of 10 concurrent creators the key", async () => {
      const key = `${root}/create-race/lease`;
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.create(key, `writer-${i}`)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.indexOf(true);
      expect(text(await store.get(key))).toBe(`writer-${winner}`);
    }, timeout);

    it("appends, creating a missing object", async () => {
      const key = `${root}/append/log.txt`;
      await store.append(key, "a\n");
      await store.append(key, "b\n");
      expect(text(await store.get(key))).toBe("a\nb\n");
      const created = `${root}/append/created.jsonl`;
      expect(await store.create(created, "")).toBe(true);
      await store.append(created, new TextEncoder().encode("{}\n"));
      expect(text(await store.get(created))).toBe("{}\n");
    }, timeout);

    it("keeps 20 concurrent appends to an existing object whole and once each", async () => {
      const key = `${root}/append-race/journal.jsonl`;
      expect(await store.create(key, "")).toBe(true);
      const lines = Array.from({ length: 20 }, (_, i) => `${JSON.stringify({ i, pad: "x".repeat(200 + i) })}\n`);
      await Promise.all(lines.map((line) => store.append(key, line)));
      const body = text(await store.get(key))!;
      expect(body.length).toBe(lines.join("").length);
      const got = body.split("\n").filter(Boolean);
      expect(got).toHaveLength(20);
      expect([...got].sort()).toEqual(lines.map((line) => line.trimEnd()).sort());
    }, timeout);

    it("lands 20 concurrent first appends to a missing object", async () => {
      const key = `${root}/append-first/new.log`;
      const lines = Array.from({ length: 20 }, (_, i) => `line ${String(i).padStart(2, "0")}\n`);
      await Promise.all(lines.map((line) => store.append(key, line)));
      const got = text(await store.get(key))!.split("\n").filter(Boolean);
      expect([...got].sort()).toEqual(lines.map((line) => line.trimEnd()));
    }, timeout);

    it("lists recursively, in lexical order, by prefix, without directory markers", async () => {
      const base = `${root}/list`;
      const keys = [
        `${base}/x/a.txt`,
        `${base}/x/a-b.txt`,
        `${base}/x/a/c.txt`,
        `${base}/x/b/d/e/f.txt`,
        `${base}/x/sp ace ü.txt`,
        `${base}/x/日本/語.txt`,
        `${base}/x/z.txt`,
        `${base}/xy/outside.txt`,
      ];
      for (const key of keys) await store.put(key, key);
      const listed = await store.list(`${base}/x/`);
      const expected = keys.filter((key) => key.startsWith(`${base}/x/`)).sort();
      expect(listed.map((entry) => entry.key)).toEqual(expected);
      for (const entry of listed) {
        expect(entry.key.endsWith("/")).toBe(false);
        expect(entry.size).toBe(new TextEncoder().encode(entry.key).byteLength);
      }
      // A prefix that ends mid-segment matches keys, not directories.
      expect((await store.list(`${base}/x/a`)).map((entry) => entry.key)).toEqual([`${base}/x/a-b.txt`, `${base}/x/a.txt`, `${base}/x/a/c.txt`]);
      expect((await store.list(`${base}/x`)).map((entry) => entry.key)).toEqual(keys.slice().sort());
      expect(await store.list(`${base}/nothing-here/`)).toEqual([]);
    }, timeout);

    it("heads objects with their size", async () => {
      const key = `${root}/head/five.txt`;
      await store.put(key, "hello");
      const entry = await store.head(key);
      expect(entry).not.toBeNull();
      expect(entry!.key).toBe(key);
      expect(entry!.size).toBe(5);
      expect(await store.head(`${root}/head`)).toBeNull();
    }, timeout);

    it("deletes objects, and deleting a missing key succeeds", async () => {
      const key = `${root}/delete/doomed.txt`;
      await store.put(key, "bye");
      await store.delete(key);
      expect(await store.get(key)).toBeNull();
      expect(await store.head(key)).toBeNull();
      expect((await store.list(`${root}/delete/`)).map((entry) => entry.key)).toEqual([]);
      await store.delete(key);
      await store.delete(`${root}/delete/never/existed.txt`);
    }, timeout);

    it("rejects keys that would escape or alias", async () => {
      for (const bad of ["/abs.txt", "../escape.txt", `${root}/a/../b.txt`, `${root}//double.txt`, `${root}/./dot.txt`, `${root}/dir/`, ""]) {
        await expect(store.put(bad, "x")).rejects.toThrow();
        await expect(store.get(bad)).rejects.toThrow();
      }
    }, timeout);
  });
}
