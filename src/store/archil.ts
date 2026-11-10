// A Store on an Archil disk, over Archil's S3-compatible object API, plus Hands (serverless exec against
// a scoped mount of the disk) and Snapshots (checkpoints, branches, and reads as of a checkpoint).
//
// Everything here leans on behavior measured against the live service on 5 November 2026
// (aws-us-west-2, disk@1.11.0); docs/measurements-2026-11-05.md has the numbers. The parts that matter most:
// - A whole-object PUT is atomic for readers. A create-only PUT (If-None-Match: *) has exactly one winner.
// - Appends to an existing object are atomic. Concurrent first appends to a missing key fail with 409
//   OperationAborted and write nothing, so retrying them is safe.
// - Listings are byte-ordered and include zero-byte directory markers ("dir/"), which a Store hides.
// - The server normalizes "..", "//" and a leading "/" instead of rejecting them, so keys are checked here.
// - Exec mounts are read-only for deletes and renames unless conditional or checked out.

import {
  Archil,
  ArchilApiError,
  ArchilError,
  ArchilS3Error,
  VERSION as SDK_VERSION,
  type Disk,
  type ExecMountSpec,
} from "disk";
import {
  checkKey,
  toBytes,
  type ExecOutcome,
  type ExecRequest,
  type Hands,
  type Snapshots,
  type Store,
  type StoreEntry,
} from "./types.ts";

export interface ArchilStoreOptions {
  /** A disk ID ("dsk-…") or the disk's name. A branch's ID works too. */
  disk: string;
  /** Defaults to ARCHIL_REGION. */
  region?: string;
  /** Defaults to ARCHIL_API_KEY. */
  apiKey?: string;
  /** Root the atoll at this key prefix ("atolls/radar"), so several atolls can share one disk. */
  prefix?: string;
  /** Reuse a client instead of creating one. */
  archil?: Archil;
}

/** An Archil failure, restated for a person: what was attempted, on which disk, and what to do. */
export class ArchilStoreError extends Error {
  readonly operation: string;
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, details: { operation: string; status?: number; code?: string; cause?: unknown }) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ArchilStoreError";
    this.operation = details.operation;
    this.status = details.status;
    this.code = details.code;
  }
}

/** The append limit the Store interface promises (Archil accepted up to 2047 KiB when probed). */
export const MAX_APPEND_BYTES = 1024 * 1024;
/** Archil's documented limit on an exec command's length. */
export const MAX_EXEC_COMMAND_BYTES = 100 * 1024;
/** The mount key for exec: the store's disk appears at /mnt/archil/s. */
export const EXEC_MOUNT = "/mnt/archil/s";

const DISK_ID = /^(dsk-|fs-)[0-9a-fA-F]+$/;
const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A branch handle's disk name: "__branch__<root disk ID>__<branch name>". */
const BRANCH_DISK_NAME = /^__branch__(dsk-[0-9a-fA-F]+)__(.+)$/;
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

export class ArchilStore implements Store, Hands, Snapshots {
  readonly location: string;
  readonly archil: Archil;
  readonly disk: Disk;
  /** "" or a prefix ending in "/". */
  readonly prefix: string;
  private readonly region: string | undefined;

  private constructor(archil: Archil, disk: Disk, prefix: string, region: string | undefined) {
    this.archil = archil;
    this.disk = disk;
    this.prefix = prefix;
    this.region = region;
    this.location = `archil:${disk.id}${prefix ? `/${prefix.slice(0, -1)}` : ""}`;
  }

  /** Open a store on a disk, found by ID or by name. */
  static async open(options: ArchilStoreOptions): Promise<ArchilStore> {
    const region = options.region ?? process.env.ARCHIL_REGION;
    const archil = options.archil ?? new Archil({ apiKey: options.apiKey, region });
    const disk = await resolveDisk(archil, options.disk, region);
    assertSdkInternals(disk);
    return new ArchilStore(archil, disk, normalizePrefix(options.prefix), region);
  }

  get diskId(): string {
    return this.disk.id;
  }

  private full(key: string): string {
    const checked = checkKey(key);
    // The SDK's XML parser trims listed keys, so a key with outer whitespace would list as another key.
    if (checked !== checked.trim()) throw new Error(`Invalid store key "${key}": no leading or trailing whitespace on Archil`);
    return this.prefix + checked;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const full = this.full(key);
    try {
      return await this.disk.getObject(full);
    } catch (error) {
      if (isMissingKey(error)) return null;
      throw explain("read", `"${key}"`, this.location, error);
    }
  }

  async put(key: string, body: Uint8Array | string): Promise<void> {
    const full = this.full(key);
    try {
      await this.disk.putObject(full, toBytes(body));
    } catch (error) {
      throw explain("write", `"${key}"`, this.location, error);
    }
  }

  async create(key: string, body: Uint8Array | string): Promise<boolean> {
    const full = this.full(key);
    try {
      return await createOnlyPut(this.disk, full, toBytes(body));
    } catch (error) {
      throw explain("create", `"${key}"`, this.location, error);
    }
  }

  async append(key: string, body: Uint8Array | string): Promise<void> {
    const full = this.full(key);
    const bytes = toBytes(body);
    if (bytes.byteLength > MAX_APPEND_BYTES) {
      throw new ArchilStoreError(`An append is at most 1 MiB; this one to "${key}" is ${bytes.byteLength} bytes`, { operation: "append" });
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await this.disk.appendObject(full, bytes);
        return;
      } catch (error) {
        // Racing first appends to a missing key: the losers wrote nothing, and the key exists now.
        if (isFirstAppendRace(error) && attempt < 8) {
          await sleep(jitter(attempt, 25, 400));
          continue;
        }
        if (!(error instanceof ArchilError)) {
          throw new ArchilStoreError(
            `Append to "${key}" on ${this.location} failed before Archil answered (${messageOf(error)}). ` +
              "The bytes may or may not have landed, so check the object before appending again.",
            { operation: "append", cause: error },
          );
        }
        throw explain("append to", `"${key}"`, this.location, error);
      }
    }
  }

  async head(key: string): Promise<StoreEntry | null> {
    const full = this.full(key);
    try {
      const meta = await this.disk.headObject(full);
      if (!meta) return null;
      const entry: StoreEntry = { key, size: meta.size };
      if (meta.etag !== undefined) entry.etag = meta.etag;
      if (meta.lastModified !== undefined) entry.lastModified = meta.lastModified;
      return entry;
    } catch (error) {
      throw explain("stat", `"${key}"`, this.location, error);
    }
  }

  async list(prefix: string): Promise<StoreEntry[]> {
    const full = this.prefix + checkPrefix(prefix);
    let objects;
    try {
      ({ objects } = await this.disk.listObjects(full, { recursive: true }));
    } catch (error) {
      throw explain("list", `"${prefix}"`, this.location, error);
    }
    const out: StoreEntry[] = [];
    for (const object of objects) {
      // Directory markers ("dir/") and Archil's reserved .archil/ tree aren't objects an atoll owns.
      if (object.key.endsWith("/") || !object.key.startsWith(full)) continue;
      const key = object.key.slice(this.prefix.length);
      if (!this.prefix && (key === ".archil" || key.startsWith(".archil/"))) continue;
      const entry: StoreEntry = { key, size: object.size };
      if (object.etag !== undefined) entry.etag = object.etag;
      if (object.lastModified !== undefined) entry.lastModified = object.lastModified;
      out.push(entry);
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async listTop(): Promise<string[]> {
    let result;
    try {
      // Without recursive, the SDK lists one level: objects, and folders as common prefixes.
      result = await this.disk.listObjects(this.prefix);
    } catch (error) {
      throw explain("list", "the top level", this.location, error);
    }
    const names = new Set<string>();
    for (const key of [...result.commonPrefixes, ...result.objects.map((o) => o.key)]) {
      if (!key.startsWith(this.prefix)) continue;
      const name = key.slice(this.prefix.length);
      // Archil's reserved .archil/ tree isn't anyone's files.
      if (!name || (!this.prefix && (name === ".archil" || name === ".archil/"))) continue;
      names.add(name);
    }
    return [...names].sort();
  }

  async delete(key: string): Promise<void> {
    const full = this.full(key);
    try {
      await this.disk.deleteObject(full);
    } catch (error) {
      throw explain("delete", `"${key}"`, this.location, error);
    }
  }

  // ---- hands ----------------------------------------------------------------------------------------

  /**
   * Run one command in a fresh Archil microVM with this store's disk (or a branch) mounted at
   * /mnt/archil/s, scoped to `scope` under the store's prefix. The mount is conditional unless the
   * request is read-only, so deletes and renames work and the object API stays writable for everyone
   * else. The command runs from the mount root. Exec has no env or cwd options; inline them.
   */
  async exec(request: ExecRequest): Promise<ExecOutcome> {
    const scope = request.scope === undefined || request.scope === "" ? "" : checkKey(request.scope.replace(/\/+$/, ""));
    const subdirectory = (this.prefix + scope).replace(/\/$/, "");
    const diskId = request.disk ?? this.disk.id;
    if (!DISK_ID.test(diskId)) throw new Error(`Invalid disk ID "${diskId}" for exec: expected dsk-…`);
    const readOnly = request.readOnly === true;
    const mount: ExecMountSpec = { disk: diskId, readOnly, conditional: !readOnly };
    if (subdirectory) mount.subdirectory = subdirectory;
    const command = `cd ${EXEC_MOUNT} || exit 125\n${request.command}`;
    if (Buffer.byteLength(command) > MAX_EXEC_COMMAND_BYTES) {
      throw new ArchilStoreError(`An exec command is at most 100 KiB; this one is ${Buffer.byteLength(command)} bytes. Stage large inputs as files first.`, { operation: "exec" });
    }
    const where = `${diskId}${subdirectory ? `/${subdirectory}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.archil.exec({ disks: { s: mount }, command });
        const outcome: ExecOutcome = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        if (result.timing) {
          outcome.timing = { queueMs: result.timing.queueMs, executeMs: result.timing.executeMs, totalMs: result.timing.totalMs };
        }
        return outcome;
      } catch (error) {
        // Archil refuses to mount a subdirectory that doesn't exist, before running anything. A writable
        // exec creates its scope (a directory marker) and tries once more; a read-only one says so.
        if (subdirectory && error instanceof ArchilError && error.status === 400 && /subdirectory does not exist/i.test(error.message)) {
          if (readOnly || attempt > 0) {
            throw new ArchilStoreError(`The exec scope "${scope || subdirectory}" doesn't exist on ${where.split("/")[0]} yet; write a file under it first.`, {
              operation: "exec",
              status: 400,
              code: "NoSuchScope",
              cause: error,
            });
          }
          await this.makeDirectory(diskId, subdirectory);
          continue;
        }
        if (error instanceof ArchilError && error.status === 504) {
          throw new ArchilStoreError(
            `Exec on ${where} timed out (Archil allows 5 minutes per command). The command may or may not have finished.`,
            { operation: "exec", status: 504, code: error.code, cause: error },
          );
        }
        throw explain("exec", `(mount ${where})`, diskId === this.disk.id ? this.location : `archil:${diskId}`, error);
      }
    }
  }

  /** Create a directory (with its parents) on this disk or a branch, as a directory marker object. */
  private async makeDirectory(diskId: string, path: string): Promise<void> {
    const disk = diskId === this.disk.id ? this.disk : await this.archil.disks.get(diskId);
    try {
      await disk.putObject(`${path}/`, "");
    } catch (error) {
      throw explain("create directory", `"${path}"`, `archil:${diskId}`, error);
    }
  }

  // ---- snapshots ------------------------------------------------------------------------------------

  /**
   * Checkpoint the whole disk. Archil creates checkpoints only from a mount, so this costs one exec
   * call: `archil checkpoints create` on a conditional mount, which takes a few tens of milliseconds.
   * The checkpoint includes every object-API write that returned before the call.
   */
  async checkpoint(name: string): Promise<void> {
    checkSnapshotName("checkpoint", name);
    let result;
    try {
      result = await this.archil.exec({
        disks: { s: { disk: this.disk.id, conditional: true } },
        command: `archil checkpoints create ${EXEC_MOUNT} ${name}`,
      });
    } catch (error) {
      throw explain("checkpoint", `"${name}"`, this.location, error);
    }
    if (result.exitCode === 0) return;
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 400);
    if (/InvalidArguments|already exists/i.test(detail)) {
      throw new ArchilStoreError(
        `Checkpoint "${name}" was not created on ${this.location}: Archil rejected the name, which it does when a ` +
          `checkpoint with that name already exists (names can't be reused). Archil said: ${detail}`,
        { operation: "checkpoint", code: "CheckpointExists" },
      );
    }
    throw new ArchilStoreError(
      `Checkpoint "${name}" was not created on ${this.location}: archil checkpoints create exited ${result.exitCode}. ${detail}`,
      { operation: "checkpoint" },
    );
  }

  /**
   * Create a writable branch from a checkpoint and return its disk ID (Archil's `filesystem_id`), which
   * the object API, exec, and sandbox mounts all accept as a disk. Retries for up to 30 s while the
   * checkpoint is not yet committed. Asking again for an existing branch made from the same checkpoint
   * returns it, so a retried fork finds its branch.
   */
  async branch(name: string, fromCheckpoint: string): Promise<{ id: string; name: string }> {
    checkSnapshotName("branch", name);
    checkSnapshotName("checkpoint", fromCheckpoint);
    // A branch's own handle can't create branches; ask its root, naming the branch as the source.
    const source = BRANCH_DISK_NAME.exec(this.disk.name);
    const owner = source ? await this.archil.disks.get(source[1]!) : this.disk;
    const fromBranch = source ? source[2] : undefined;
    const deadline = Date.now() + 30_000;
    for (let attempt = 0; ; attempt++) {
      try {
        const created = await owner.createBranch(fromBranch ? { name, fromCheckpoint, fromBranch } : { name, fromCheckpoint });
        return { id: created.filesystem_id, name: created.branch_name };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const status = error instanceof ArchilError ? error.status : undefined;
        if (status === 409 && /not (yet )?committed|uncommitted/i.test(message) && Date.now() < deadline) {
          await sleep(Math.min(Date.now() + jitter(attempt, 200, 3000), deadline) - Date.now());
          continue;
        }
        if (status === 409 && /already exists/i.test(message)) {
          const existing = await owner.getBranch(name).catch(() => null);
          if (existing && existing.from_checkpoint_name === fromCheckpoint) return { id: existing.filesystem_id, name: existing.branch_name };
          throw new ArchilStoreError(
            `A branch named "${name}" already exists on ${this.location}` +
              (existing ? `, made from checkpoint "${existing.from_checkpoint_name}" rather than "${fromCheckpoint}"` : "") +
              ". Branch names can't be reused, and Archil can't delete branches yet.",
            { operation: "branch", status, code: "BranchExists", cause: error },
          );
        }
        if (status === 404 && /checkpoint/i.test(message)) {
          throw new ArchilStoreError(`No checkpoint named "${fromCheckpoint}" on ${this.location}, so branch "${name}" wasn't created (Archil: ${message})`, {
            operation: "branch",
            status,
            code: "NoSuchCheckpoint",
            cause: error,
          });
        }
        throw explain("branch", `"${name}" from "${fromCheckpoint}"`, this.location, error);
      }
    }
  }

  /** A store on a branch (or any disk ID), with this store's client and prefix. */
  async open(diskId: string): Promise<ArchilStore> {
    if (!DISK_ID.test(diskId)) throw new Error(`Invalid disk ID "${diskId}": expected the ID a branch returned (dsk-…)`);
    return ArchilStore.open({ disk: diskId, archil: this.archil, prefix: this.prefix, region: this.region });
  }

  /**
   * Read an object as it was at a checkpoint, or null if it didn't exist then. A new checkpoint isn't
   * readable for several seconds (Archil answers 503 SlowDown); this waits up to `waitMs` (60 s).
   */
  async readAt(checkpoint: string, key: string, waitMs = 60_000): Promise<Uint8Array | null> {
    checkSnapshotName("checkpoint", checkpoint);
    const full = this.full(key);
    const s3 = internals(this.disk);
    const deadline = Date.now() + waitMs;
    for (let attempt = 0; ; attempt++) {
      let response: S3Response | undefined;
      let failure: unknown;
      try {
        response = await s3._s3Request("GET", full, { query: { versionId: checkpoint }, retry: false });
      } catch (error) {
        failure = error;
      }
      if (response?.ok) return response.body;
      if (response && response.status === 404) {
        const error = s3Error("GetObject", response);
        if (error.code === "NoSuchVersion") {
          throw new ArchilStoreError(`No checkpoint named "${checkpoint}" on ${this.location} (Archil: NoSuchVersion)`, {
            operation: "readAt",
            status: 404,
            code: "NoSuchVersion",
          });
        }
        if (isMissingKey(error)) return null;
        throw explain(`read "${key}" at checkpoint`, `"${checkpoint}"`, this.location, error);
      }
      const retryable = failure !== undefined || (response !== undefined && TRANSIENT.has(response.status));
      if (retryable && Date.now() < deadline) {
        await sleep(Math.min(Date.now() + jitter(attempt, 250, 2000), deadline) - Date.now());
        continue;
      }
      if (response?.status === 503) {
        throw new ArchilStoreError(
          `Checkpoint "${checkpoint}" on ${this.location} was still not readable after ${Math.round(waitMs / 1000)} s ` +
            "(Archil: 503 SlowDown). New checkpoints take a few seconds to become readable; try again shortly.",
          { operation: "readAt", status: 503, code: "SlowDown" },
        );
      }
      throw explain(`read "${key}" at checkpoint`, `"${checkpoint}"`, this.location, failure ?? s3Error("GetObject", response!));
    }
  }
}

// ---- the create-only write ----------------------------------------------------------------------------

/** The SDK's internal S3 request method, as disk@1.11.0 defines it. */
interface S3RequestOptions {
  query?: Record<string, string | number>;
  body?: Uint8Array | string;
  contentType?: string;
  extraHeaders?: Record<string, string>;
  /** false: one attempt. Otherwise the SDK retries transport errors, 429 and 5xx three times. */
  retry?: boolean;
}
interface S3Response {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  /** The response body for GET and POST; empty for other methods. On failure, the error text (XML). */
  body: Uint8Array;
}
interface DiskInternals {
  _s3Request(method: "GET" | "HEAD" | "PUT" | "POST" | "DELETE", key: string, opts?: S3RequestOptions): Promise<S3Response>;
}

/**
 * Fails loudly if the SDK no longer has the internal method create() and readAt() depend on, rather
 * than letting create() degrade into a blind overwrite. test/store/archil.test.ts also checks, against
 * a local server, that the If-None-Match header and the versionId query reach the wire.
 */
export function assertSdkInternals(disk: Disk): void {
  if (typeof (disk as unknown as Partial<DiskInternals>)._s3Request !== "function") {
    throw new Error(
      `atoll needs the disk SDK's internal _s3Request for create-only writes and checkpoint reads, and disk@${SDK_VERSION} ` +
        "doesn't have it. Use disk@1.11.0, or update atoll.",
    );
  }
}

function internals(disk: Disk): DiskInternals {
  return disk as unknown as DiskInternals;
}

/**
 * Create an object only if none exists at the key, and say whether this call created it.
 *
 * Archil's object API honors exactly one write precondition: `If-None-Match: *` on PUT. It answers
 * 200 when the request created the object and 412 PreconditionFailed when an object already existed.
 * Probed on 5 November 2026, ten concurrent writers to one new key got exactly one 200 and nine 412s,
 * in both runs. `If-Match` on writes returns 501, so this is the only compare-and-set the object API
 * offers, and the lease, inbox delivery, and dedupe markers are all built on it.
 *
 * disk@1.11.0's putObject() can't send the header, so this goes through the SDK's internal _s3Request,
 * which reuses the SDK's credential and transport. It runs with the SDK's retries off and retries here
 * instead, because a retry changes what a 412 means: after an attempt whose answer was lost (a transport
 * error or a 5xx), a 412 may be this call's own earlier write. In that case the object is read back, and
 * the call reports true if it holds exactly these bytes. Two callers racing with identical bytes through
 * a lost answer could then both see true, which is harmless when the bytes are identical; the lease
 * writes the runner's identity into its body for that reason.
 */
async function createOnlyPut(disk: Disk, key: string, body: Uint8Array): Promise<boolean> {
  const s3 = internals(disk);
  let ambiguous = false;
  for (let attempt = 0; ; attempt++) {
    let response: S3Response;
    try {
      response = await s3._s3Request("PUT", key, {
        body,
        contentType: "application/octet-stream",
        extraHeaders: { "If-None-Match": "*" },
        retry: false,
      });
    } catch (error) {
      if (attempt >= 3) throw error;
      ambiguous = true;
      await sleep(jitter(attempt, 100, 2000));
      continue;
    }
    if (response.ok) return true;
    if (response.status === 412) {
      if (!ambiguous) return false;
      const existing = await disk.getObject(key).catch((error: unknown) => {
        if (error instanceof ArchilS3Error && error.status === 404) return null;
        throw error;
      });
      return existing !== null && sameBytes(existing, body);
    }
    if (response.status === 501) {
      throw new ArchilStoreError(
        "Archil answered 501 NotImplemented to a create-only PUT (If-None-Match: *). atoll's lease and delivery depend on it; " +
          "nothing was written.",
        { operation: "create", status: 501, code: "NotImplemented" },
      );
    }
    if (TRANSIENT.has(response.status) && attempt < 3) {
      ambiguous = true;
      await sleep(jitter(attempt, 100, 2000));
      continue;
    }
    throw s3Error("PutObject", response);
  }
}

// ---- errors -------------------------------------------------------------------------------------------

/** A 404 that means "no object at this key", as opposed to a missing disk (NoSuchBucket) or version. */
function isMissingKey(error: unknown): boolean {
  return error instanceof ArchilS3Error && error.status === 404 && (error.code === undefined || error.code === "NoSuchKey" || error.code === "NotFound");
}

function isFirstAppendRace(error: unknown): boolean {
  return error instanceof ArchilError && error.status === 409 && /created by another writer/i.test(error.message);
}

function isDelegationConflict(error: ArchilError): boolean {
  return (error.status === 409 || error.status === 400) && /delegation/i.test(error.message);
}

/** Restate an Archil failure with the operation, the target, the disk, and what to do about it. */
function explain(operation: string, target: string, location: string, error: unknown): Error {
  if (error instanceof ArchilStoreError) return error;
  if (!(error instanceof ArchilError)) {
    return new ArchilStoreError(`Archil ${operation} ${target} on ${location} failed before Archil answered: ${messageOf(error)}`, {
      operation,
      cause: error,
    });
  }
  const details = { operation, status: error.status, code: error.code, cause: error };
  const said = detailOf(error);
  if (isDelegationConflict(error)) {
    return new ArchilStoreError(
      `Archil refused to ${operation} ${target} on ${location} because another client holds a write delegation: the disk is ` +
        "mounted exclusively somewhere (usually a sandbox or Linux client with a plain mount, which keeps the delegation even " +
        `while paused). Mount it with conditional: true or readOnly: true, or release the delegation, then retry. Archil said: ${said}`,
      details,
    );
  }
  if (error.status === 403 && /allowance|plan|limit/i.test(`${error.code ?? ""} ${error.message}`)) {
    return new ArchilStoreError(`Archil refused to ${operation} ${target} on ${location}: the account's plan allowance is used up or doesn't cover it. ${said}`, details);
  }
  if (error.status === 401 || (error.status === 403 && /AccessDenied|unauthor|forbidden/i.test(`${error.code ?? ""} ${error.message}`))) {
    return new ArchilStoreError(`Archil rejected the credential for ${operation} ${target} on ${location}. Check ARCHIL_API_KEY and ARCHIL_REGION. ${said}`, details);
  }
  if (error.status === 404 && error instanceof ArchilApiError) {
    return new ArchilStoreError(`Archil ${operation} ${target} failed: ${location} was not found in this region. ${said}`, details);
  }
  if (error.status === 409 && /blocks the path|names an existing directory|exists as a directory/i.test(error.message)) {
    return new ArchilStoreError(`Can't ${operation} ${target} on ${location}: a file and a directory would share a path. ${said}`, details);
  }
  return new ArchilStoreError(`Archil ${operation} ${target} on ${location} failed: ${said}`, details);
}

/** "409 OperationAborted: The path … cannot be written …", without the SDK's own prefix. */
function detailOf(error: ArchilError): string {
  const code = error.code ? ` ${error.code}` : "";
  if (error instanceof ArchilS3Error) {
    const message = xmlTag(error.raw, "Message");
    return `${error.status}${code}${message ? `: ${message}` : ""}`;
  }
  return `${error.status}${code}: ${error.message}`;
}

function s3Error(operation: string, response: S3Response): ArchilS3Error {
  const raw = new TextDecoder().decode(response.body);
  const options: ConstructorParameters<typeof ArchilS3Error>[0] = { operation, statusCode: response.status, statusText: response.statusText, raw };
  const code = xmlTag(raw, "Code");
  const message = xmlTag(raw, "Message");
  const requestId = xmlTag(raw, "RequestId");
  if (code !== undefined) options.code = code;
  if (message !== undefined) options.message = message;
  if (requestId !== undefined) options.requestId = requestId;
  return new ArchilS3Error(options);
}

function xmlTag(xml: string | undefined, tag: string): string | undefined {
  const match = xml ? new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml) : null;
  return match ? decodeXml(match[1]!) : undefined;
}

function decodeXml(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos);/g, (_, name: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[name]!);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ? `${error.message} (${cause.code})` : error.message;
  }
  return String(error);
}

// ---- helpers ------------------------------------------------------------------------------------------

async function resolveDisk(archil: Archil, ref: string, region: string | undefined): Promise<Disk> {
  const where = region ? ` in ${region}` : "";
  if (DISK_ID.test(ref)) {
    try {
      return await archil.disks.get(ref);
    } catch (error) {
      if (error instanceof ArchilError && error.status === 404) throw new Error(`No Archil disk with ID ${ref}${where}.`);
      throw explain("open", ref, `archil${where}`, error);
    }
  }
  let disks: Disk[];
  try {
    disks = await archil.disks.list({ name: ref });
  } catch (error) {
    throw explain("look up", `disk "${ref}"`, `archil${where}`, error);
  }
  const matches = disks.filter((disk) => disk.name === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`No Archil disk named "${ref}"${where}. Pass a disk ID (dsk-…), or create the disk first.`);
  throw new Error(`${matches.length} Archil disks are named "${ref}"${where} (${matches.map((d) => d.id).join(", ")}); pass the disk ID.`);
}

function normalizePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  return trimmed ? `${checkKey(trimmed)}/` : "";
}

/** A listing prefix may be empty or end with "/", but must not climb or start at the root. */
function checkPrefix(prefix: string): string {
  if (prefix === "") return prefix;
  const body = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  checkKey(body);
  return prefix;
}

function checkSnapshotName(kind: string, name: string): void {
  if (!SNAPSHOT_NAME.test(name)) {
    throw new Error(`Invalid ${kind} name "${name}": use letters, digits, ".", "_" and "-", starting with a letter or digit (at most 100)`);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Full jitter: a random delay up to min(cap, base * 2^attempt). */
function jitter(attempt: number, baseMs: number, capMs: number): number {
  return Math.random() * Math.min(capMs, baseMs * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
