// A Store on a directory. Used for local atolls in development and tests, and by the door, where the
// directory is an Archil disk mounted in conditional mode (creates, renames and deletes execute on the
// disk server before they return, and close() waits for the file's writes to reach the disk).

import { execFile } from "node:child_process";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { checkKey, toBytes, type Store, type StoreEntry } from "./types.ts";

export interface LocalStoreOptions {
  /** When the directory is an Archil mount, the mount point: refresh() runs `archil invalidate-cache` on it. */
  archilMount?: string;
}

export class LocalStore implements Store {
  readonly location: string;
  readonly root: string;
  private readonly options: LocalStoreOptions;

  constructor(root: string, options: LocalStoreOptions = {}) {
    this.root = root;
    this.location = options.archilMount ? `mount:${root}` : `dir:${root}`;
    this.options = options;
  }

  private path(key: string): string {
    return join(this.root, ...checkKey(key).split("/"));
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async put(key: string, body: Uint8Array | string): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    // Write a sibling temp file and rename it over the target, so readers see the old or the new object.
    const temp = `${path}.atoll-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(toBytes(body));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  }

  async create(key: string, body: Uint8Array | string): Promise<boolean> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    let handle;
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      await handle.writeFile(toBytes(body));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  }

  async append(key: string, body: Uint8Array | string): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a");
    try {
      await handle.write(toBytes(body));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async head(key: string): Promise<StoreEntry | null> {
    try {
      const info = await stat(this.path(key));
      if (!info.isFile()) return null;
      return { key, size: info.size, lastModified: info.mtime };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<StoreEntry[]> {
    // List the deepest directory the prefix names, then filter by the full prefix.
    const slash = prefix.lastIndexOf("/");
    const base = slash >= 0 ? prefix.slice(0, slash) : "";
    const start = base ? join(this.root, ...base.split("/")) : this.root;
    const out: StoreEntry[] = [];
    let names: string[];
    try {
      names = (await readdir(start, { recursive: true })) as string[];
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    for (const name of names) {
      const full = join(start, name);
      const key = relative(this.root, full).split(sep).join("/");
      if (!key.startsWith(prefix) || key.includes(".atoll-tmp-")) continue;
      try {
        const info = await stat(full);
        if (info.isFile()) out.push({ key, size: info.size, lastModified: info.mtime });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async listTop(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return entries.filter((e) => e.name !== ".DS_Store").map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async refresh(): Promise<void> {
    if (!this.options.archilMount) return;
    // A mounted client can serve directory listings up to five minutes stale; drop its cache.
    await new Promise<void>((resolve) => {
      execFile("archil", ["invalidate-cache", this.options.archilMount!], () => resolve());
    });
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Create the directory for a local atoll if needed. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export { writeFile, appendFile };
