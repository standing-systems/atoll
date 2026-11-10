// A Store is the disk as atoll's control plane sees it: whole-object reads and writes, an atomic
// create-only write, atomic appends, and recursive listings. Keys are relative to the atoll's root and
// use "/" separators, with no leading slash. LocalStore implements it on a directory (a temp dir in
// tests, or an Archil mount inside the door); ArchilStore implements it over Archil's object API.

export interface StoreEntry {
  key: string;
  size: number;
  etag?: string;
  lastModified?: Date;
}

export interface Store {
  /** Where this store points, for messages: "dir:/tmp/x" or "archil:dsk-…". */
  readonly location: string;
  /** Read an object, or null when none exists. */
  get(key: string): Promise<Uint8Array | null>;
  /** Create or replace an object. Durable when it returns. */
  put(key: string, body: Uint8Array | string): Promise<void>;
  /**
   * Create an object only if no object exists at the key: true if this call created it, false if one
   * already existed. Exactly one of any number of concurrent callers gets true.
   */
  create(key: string, body: Uint8Array | string): Promise<boolean>;
  /**
   * Append bytes, creating the object if it is missing. One call is atomic: concurrent appends to an
   * existing object never interleave. At most 1 MiB per call. Not safe to retry blindly.
   */
  append(key: string, body: Uint8Array | string): Promise<void>;
  head(key: string): Promise<StoreEntry | null>;
  /** Every object under the prefix, recursively, in lexical key order. Directory markers are excluded. */
  list(prefix: string): Promise<StoreEntry[]>;
  /** The names at the store's root, folders with a trailing slash. Used to look before laying out an atoll. */
  listTop?(): Promise<string[]>;
  /** Delete an object. Deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** Called by a runner at the start of a tick; a mounted store drops its client cache here. */
  refresh?(): Promise<void>;
}

export interface ExecRequest {
  command: string;
  /** Limit the mount to this subdirectory of the atoll (default: the whole atoll). */
  scope?: string;
  readOnly?: boolean;
  /** Run against a branch (a disk ID) instead of the atoll's own disk. */
  disk?: string;
}

export interface ExecOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Milliseconds as Archil reports them, when available. */
  timing?: { queueMs?: number; executeMs?: number; totalMs?: number };
}

/** Untrusted compute attached to the store's disk. ArchilStore provides it with serverless exec. */
export interface Hands {
  exec(request: ExecRequest): Promise<ExecOutcome>;
}

/** Checkpoints and branches of the store's disk. */
export interface Snapshots {
  /** Create a named checkpoint of the whole disk. */
  checkpoint(name: string): Promise<void>;
  /** Create a writable branch from a checkpoint; returns the branch's disk ID. */
  branch(name: string, fromCheckpoint: string): Promise<{ id: string; name: string }>;
  /** Open a store on a branch (a disk ID returned by `branch`). */
  open(diskId: string): Promise<Store & Partial<Hands> & Partial<Snapshots>>;
  /** Read a file as it was at a checkpoint, or null if it didn't exist then. */
  readAt?(checkpoint: string, key: string): Promise<Uint8Array | null>;
}

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function toBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? enc.encode(body) : body;
}

export function asText(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : dec.decode(bytes);
}

export function hasHands(store: object): store is Hands {
  return typeof (store as Partial<Hands>).exec === "function";
}

export function hasSnapshots(store: object): store is Snapshots {
  return typeof (store as Partial<Snapshots>).checkpoint === "function" && typeof (store as Partial<Snapshots>).branch === "function";
}

/** Normalize and validate a key: no leading slash, no "." or ".." segments, no empty segments. */
export function checkKey(key: string): string {
  if (key.startsWith("/") || key.endsWith("/") || key.length === 0) throw new Error(`Invalid store key "${key}"`);
  for (const segment of key.split("/")) {
    if (segment === "" || segment === "." || segment === "..") throw new Error(`Invalid store key "${key}"`);
  }
  return key;
}
