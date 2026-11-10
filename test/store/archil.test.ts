// ArchilStore against a local stand-in for Archil (test/store/fake-archil.ts). These tests pin what
// reaches the wire through the SDK's real transport, so an SDK upgrade that changes the internals
// create() and readAt() depend on fails here, and they cover the retry paths that live races hit only
// sometimes. test/live/store.test.ts runs the same Store contract against the real service.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Archil } from "disk";
import type { Disk } from "disk";
import { ArchilStore, assertSdkInternals } from "../../src/store/archil.ts";
import { asText } from "../../src/store/types.ts";
import { BRANCH_ID, DISK_ID, diskJson, json, listLevelXml, listXml, s3Error, startFakeArchil, type FakeArchil, type SeenRequest } from "./fake-archil.ts";

let fake: FakeArchil;
let archil: Archil;

beforeAll(async () => {
  fake = await startFakeArchil();
  archil = new Archil({ apiKey: "key-offline-test", region: "aws-us-west-2", baseUrl: fake.url, s3BaseUrl: fake.url });
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => fake.reset());

const objectPath = (key: string) => `/${DISK_ID}/${key.split("/").map(encodeURIComponent).join("/")}`;
const isObject = (method: string, key: string) => (r: SeenRequest) => r.method === method && r.path === objectPath(key);
const open = (prefix?: string) => ArchilStore.open(prefix === undefined ? { disk: DISK_ID, archil } : { disk: DISK_ID, archil, prefix });

describe("ArchilStore offline: the SDK internals it depends on", () => {
  it("checks that the SDK still has _s3Request", () => {
    expect(() => assertSdkInternals({} as Disk)).toThrow(/_s3Request/);
  });

  it("sends create-only PUTs with If-None-Match: * and maps 200 and 412", async () => {
    const store = await open("atolls/radar");
    fake.queue(isObject("PUT", "atolls/radar/.atoll/lease/1"), { status: 200 }, s3Error(412, "PreconditionFailed", "At least one of the preconditions you specified did not hold."));
    expect(await store.create(".atoll/lease/1", '{"runner":"a"}')).toBe(true);
    expect(await store.create(".atoll/lease/1", '{"runner":"b"}')).toBe(false);
    const puts = fake.requests.filter((r) => r.method === "PUT");
    expect(puts).toHaveLength(2);
    for (const put of puts) {
      expect(put.headers["if-none-match"]).toBe("*");
      expect([...put.query.keys()]).toEqual([]);
    }
    expect(puts[0]!.body.toString()).toBe('{"runner":"a"}');
    expect(store.location).toBe(`archil:${DISK_ID}/atolls/radar`);
  });

  it("settles a 412 after a lost answer by reading the object back", async () => {
    const store = await open();
    fake.queue(isObject("PUT", "inbox/e1.json"), s3Error(500, "InternalError", "try again"), s3Error(412, "PreconditionFailed", "exists"));
    fake.queue(isObject("GET", "inbox/e1.json"), { status: 200, body: "mine" });
    expect(await store.create("inbox/e1.json", "mine")).toBe(true);

    fake.queue(isObject("PUT", "inbox/e2.json"), s3Error(503, "SlowDown", "slow"), s3Error(412, "PreconditionFailed", "exists"));
    fake.queue(isObject("GET", "inbox/e2.json"), { status: 200, body: "someone else's" });
    expect(await store.create("inbox/e2.json", "mine")).toBe(false);
  });

  it("refuses to treat a 501 as success", async () => {
    const store = await open();
    fake.queue(isObject("PUT", "x"), s3Error(501, "NotImplemented", "The precondition is not implemented for this operation."));
    await expect(store.create("x", "1")).rejects.toThrow(/501/);
  });

  it("reads at a checkpoint with versionId, waiting out SlowDown", async () => {
    const store = await open();
    fake.queue(
      isObject("GET", "parts/a.json"),
      s3Error(503, "SlowDown", "The checkpoint is not readable yet. Please retry."),
      s3Error(503, "SlowDown", "The checkpoint is not readable yet. Please retry."),
      { status: 200, body: "old" },
    );
    expect(asText(await store.readAt("cp-1", "parts/a.json"))).toBe("old");
    const gets = fake.requests.filter((r) => r.method === "GET" && r.path === objectPath("parts/a.json"));
    expect(gets).toHaveLength(3);
    expect(gets.every((r) => r.query.get("versionId") === "cp-1")).toBe(true);

    fake.queue(isObject("GET", "parts/new.json"), s3Error(404, "NoSuchKey", "The specified key does not exist."));
    expect(await store.readAt("cp-1", "parts/new.json")).toBeNull();
    fake.queue(isObject("GET", "parts/a.json"), s3Error(404, "NoSuchVersion", "The specified version does not exist."));
    await expect(store.readAt("cp-nope", "parts/a.json")).rejects.toThrow(/No checkpoint named "cp-nope"/);
  });

  it("gives up on an unreadable checkpoint with a clear message", async () => {
    const store = await open();
    fake.on((r) => (isObject("GET", "slow.txt")(r) ? s3Error(503, "SlowDown", "not readable yet") : undefined));
    await expect(store.readAt("cp-2", "slow.txt", 300)).rejects.toThrow(/still not readable/);
  });
});

describe("ArchilStore offline: objects", () => {
  it("maps missing keys to null", async () => {
    const store = await open();
    fake.queue(isObject("GET", "nope.txt"), s3Error(404, "NoSuchKey", "The specified key does not exist."));
    expect(await store.get("nope.txt")).toBeNull();
    fake.queue(isObject("HEAD", "nope.txt"), { status: 404 });
    expect(await store.head("nope.txt")).toBeNull();
    // A missing disk is an error, not an empty store.
    fake.queue(isObject("GET", "nope.txt"), s3Error(404, "NoSuchBucket", "The specified bucket does not exist"));
    await expect(store.get("nope.txt")).rejects.toThrow(/404 NoSuchBucket/);
  });

  it("retries racing first appends and nothing else", async () => {
    const store = await open();
    const race = s3Error(409, "OperationAborted", "The destination key was created by another writer while this append was in progress. Retry the append.");
    fake.queue(isObject("PUT", "journal/2026-11-05.jsonl"), race, race, { status: 200 });
    await store.append("journal/2026-11-05.jsonl", "{}\n");
    const appends = fake.requests.filter((r) => r.method === "PUT");
    expect(appends).toHaveLength(3);
    expect(appends.every((r) => r.query.get("append") === "true" && r.body.toString() === "{}\n")).toBe(true);

    fake.reset();
    fake.queue(
      isObject("PUT", "journal/2026-11-05.jsonl"),
      s3Error(409, "OperationAborted", "The path /journal cannot be written because another client holds a write delegation. Release the delegation before retrying."),
    );
    await expect(store.append("journal/2026-11-05.jsonl", "{}\n")).rejects.toThrow(/mounted exclusively somewhere.*conditional: true/s);
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("refuses appends over 1 MiB without sending them", async () => {
    const store = await open();
    await expect(store.append("big", new Uint8Array(1024 * 1024 + 1))).rejects.toThrow(/at most 1 MiB/);
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("explains a write refused by an exclusive mount", async () => {
    const store = await open();
    fake.queue(isObject("PUT", "STATUS.md"), s3Error(409, "OperationAborted", "The path /STATUS.md cannot be written because another client holds a write delegation."));
    await expect(store.put("STATUS.md", "x")).rejects.toThrow(/write delegation: the disk is mounted exclusively/);
  });

  it("lists under the prefix, without directory markers, sorted", async () => {
    const store = await open("pre/fix");
    fake.queue(
      (r) => r.method === "GET" && r.path === `/${DISK_ID}`,
      listXml("pre/fix/", [
        { key: "pre/fix/", size: 0 },
        { key: "pre/fix/b.txt", size: 2 },
        { key: "pre/fix/a/", size: 0 },
        { key: "pre/fix/a/c.txt", size: 3 },
        { key: "pre/fix/A.txt", size: 1 },
      ]),
    );
    const listed = await store.list("");
    expect(listed.map((e) => [e.key, e.size])).toEqual([
      ["A.txt", 1],
      ["a/c.txt", 3],
      ["b.txt", 2],
    ]);
    const request = fake.requests.find((r) => r.method === "GET" && r.path === `/${DISK_ID}`)!;
    expect(request.query.get("list-type")).toBe("2");
    expect(request.query.get("prefix")).toBe("pre/fix/");
    expect(request.query.has("delimiter")).toBe(false);
  });

  it("lists its top level one level deep, folders as prefixes, without Archil's reserved tree", async () => {
    const store = await open();
    const level = (r: SeenRequest) => r.method === "GET" && r.path === `/${DISK_ID}` && r.query.get("delimiter") === "/";
    fake.queue(level, listLevelXml("", ["notes.txt"], [".archil/", "memory/", "workspace/"]));
    expect(await store.listTop()).toEqual(["memory/", "notes.txt", "workspace/"]);
    const prefixed = await open("pre/fix");
    fake.queue((r) => level(r) && r.query.get("prefix") === "pre/fix/", listLevelXml("pre/fix/", ["pre/fix/CHARTER.md"], ["pre/fix/parts/"]));
    expect(await prefixed.listTop()).toEqual(["CHARTER.md", "parts/"]);
  });

  it("rejects keys Archil would normalize into other keys", async () => {
    const store = await open();
    for (const bad of ["a/../b", "a//b", "/a", "a/", " padded "]) await expect(store.put(bad, "x")).rejects.toThrow(/Invalid store key/);
    await expect(store.list("../")).rejects.toThrow(/Invalid store key/);
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("opens a disk by name", async () => {
    fake.on((r) => (r.method === "GET" && r.path === "/api/disks" && r.query.get("name") === "radar" ? json(200, { success: true, data: [diskJson(DISK_ID, "radar")].map((d) => JSON.parse(String(d.body)).data) }) : undefined));
    fake.on((r) => (r.method === "GET" && r.path === "/api/disks" ? json(200, { success: true, data: [] }) : undefined));
    expect((await ArchilStore.open({ disk: "radar", archil })).diskId).toBe(DISK_ID);
    await expect(ArchilStore.open({ disk: "nothing", archil })).rejects.toThrow(/No Archil disk named "nothing"/);
  });
});

describe("ArchilStore offline: hands and snapshots", () => {
  const execBody = (r: SeenRequest) => JSON.parse(r.body.toString()) as { disks: Record<string, Record<string, unknown>>; command: string };
  const execReply = (exitCode: number, stdout = "", stderr = "") => json(200, { success: true, data: { exitCode, stdout, stderr, timing: { totalMs: 50, queueMs: 40, executeMs: 10 } } });

  it("execs on a conditional mount scoped under the prefix, from the mount root", async () => {
    const store = await open("pre/fix");
    fake.queue((r) => r.path === "/api/exec", execReply(0, "ok\n"), execReply(1, "", "Read-only file system"), execReply(0));
    const out = await store.exec({ command: "echo ok", scope: "workspace" });
    expect(out).toEqual({ exitCode: 0, stdout: "ok\n", stderr: "", timing: { queueMs: 40, executeMs: 10, totalMs: 50 } });
    await store.exec({ command: "touch x", scope: "workspace/", readOnly: true });
    await store.exec({ command: "ls", disk: BRANCH_ID });
    const [first, second, third] = fake.requests.filter((r) => r.path === "/api/exec").map(execBody);
    expect(first!.disks).toEqual({ s: { disk: DISK_ID, readOnly: false, conditional: true, subdirectory: "pre/fix/workspace" } });
    expect(first!.command).toBe("cd /mnt/archil/s || exit 125\necho ok");
    expect(second!.disks).toEqual({ s: { disk: DISK_ID, readOnly: true, conditional: false, subdirectory: "pre/fix/workspace" } });
    expect(third!.disks).toEqual({ s: { disk: BRANCH_ID, readOnly: false, conditional: true, subdirectory: "pre/fix" } });
  });

  it("creates a missing scope for a writable exec, and explains it for a read-only one", async () => {
    const store = await open();
    const missing = json(400, { success: false, error: `Exec failed: disk ${DISK_ID}: the configured subdirectory does not exist`, code: "invalid_request" });
    fake.queue((r) => r.path === "/api/exec", missing, execReply(0, "ran\n"), missing);
    fake.queue(isObject("PUT", "workspace/"), { status: 200 });
    expect((await store.exec({ command: "true", scope: "workspace" })).stdout).toBe("ran\n");
    const marker = fake.requests.find((r) => r.method === "PUT")!;
    expect(marker.path).toBe(`/${DISK_ID}/workspace/`);
    expect(marker.body.byteLength).toBe(0);
    await expect(store.exec({ command: "ls", scope: "workspace", readOnly: true })).rejects.toThrow(/exec scope "workspace" doesn't exist/);
    expect(fake.requests.filter((r) => r.path === "/api/exec")).toHaveLength(3);
  });

  it("checkpoints the whole disk in one exec and explains a reused name", async () => {
    const store = await open("pre/fix");
    fake.queue(
      (r) => r.path === "/api/exec",
      execReply(0, "Checkpoint 'cp-1' created successfully.\n"),
      execReply(1, "", 'Failed to create checkpoint: ServerError("Failed to create checkpoint: InvalidArguments")'),
    );
    await store.checkpoint("cp-1");
    await expect(store.checkpoint("cp-1")).rejects.toThrow(/already exists/);
    const body = execBody(fake.requests.find((r) => r.path === "/api/exec")!);
    expect(body).toEqual({ disks: { s: { disk: DISK_ID, readOnly: false, conditional: true } }, command: "archil checkpoints create /mnt/archil/s cp-1" });
    await expect(store.checkpoint("bad name; rm -rf /")).rejects.toThrow(/Invalid checkpoint name/);
  });

  it("retries branch creation while the checkpoint commits, and finds an existing branch", async () => {
    const store = await open();
    const branch = { branch_name: "trial", filesystem_id: BRANCH_ID, from_checkpoint_name: "cp-1", from_checkpoint_filesystem_id: DISK_ID, root_filesystem_id: DISK_ID, created_at: "2026-11-05T00:00:00Z" };
    const isCreate = (r: SeenRequest) => r.method === "POST" && r.path === `/api/disks/${DISK_ID}/branches`;
    fake.queue(isCreate, json(409, { success: false, error: 'Checkpoint "cp-1" is not yet committed', code: "conflict" }), json(201, { success: true, data: branch }));
    expect(await store.branch("trial", "cp-1")).toEqual({ id: BRANCH_ID, name: "trial" });
    expect(fake.requests.filter(isCreate)).toHaveLength(2);

    fake.queue(isCreate, json(409, { success: false, error: 'Branch "trial" already exists', code: "conflict" }));
    fake.queue((r) => r.method === "GET" && r.path === `/api/disks/${DISK_ID}/branches/trial`, json(200, { success: true, data: branch }));
    expect(await store.branch("trial", "cp-1")).toEqual({ id: BRANCH_ID, name: "trial" });
    expect(JSON.parse(fake.requests.filter(isCreate).at(-1)!.body.toString())).toEqual({ branch_name: "trial", from_checkpoint_name: "cp-1" });
  });

  it("opens a branch, and branches a branch through its root", async () => {
    const store = await open();
    const branchStore = await store.open(BRANCH_ID);
    expect(branchStore.location).toBe(`archil:${BRANCH_ID}`);
    const isCreate = (r: SeenRequest) => r.method === "POST" && r.path === `/api/disks/${DISK_ID}/branches`;
    fake.queue(isCreate, json(201, { success: true, data: { branch_name: "deeper", filesystem_id: "dsk-00000000000000c3", from_checkpoint_name: "cp-b" } }));
    expect(await branchStore.branch("deeper", "cp-b")).toEqual({ id: "dsk-00000000000000c3", name: "deeper" });
    expect(JSON.parse(fake.requests.find(isCreate)!.body.toString())).toEqual({ branch_name: "deeper", from_checkpoint_name: "cp-b", from_branch: "trial" });
  });
});
