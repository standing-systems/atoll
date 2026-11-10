// Where a CLI command points: a project (the directory with system.ts) and an atoll (a local directory or
// an Archil disk).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LocalStore } from "../store/local.ts";
import type { Store } from "../store/types.ts";

export interface Project {
  root: string;
  entry: string;
  name?: string;
  disk?: string;
  dir?: string;
  prefix?: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class NotInProject extends Error {
  constructor(message = "Not in an atoll project: no system.ts here or above (or pass --dir / --disk)") {
    super(message);
    this.name = "NotInProject";
  }
}

/** The nearest directory at or above `from` with a package.json "atoll" field or a system.ts. */
export function findProject(from = process.cwd()): Project | null {
  let dir = resolve(from);
  for (;;) {
    const pkgPath = join(dir, "package.json");
    let config: { entry?: string; disk?: string; dir?: string; name?: string; prefix?: string } | undefined;
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.atoll && typeof pkg.atoll === "object") config = pkg.atoll;
      } catch {
        // An unreadable package.json is not a project marker.
      }
    }
    const entry = join(dir, config?.entry ?? "system.ts");
    if (config || existsSync(entry)) {
      if (existsSync(entry)) {
        return {
          root: dir,
          entry,
          ...(config?.name ? { name: config.name } : {}),
          ...(config?.disk ? { disk: config.disk } : {}),
          ...(config?.dir ? { dir: resolve(dir, config.dir) } : {}),
          ...(config?.prefix ? { prefix: config.prefix } : {}),
        };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface TargetFlags {
  dir?: string;
  disk?: string;
  mounted?: string;
  prefix?: string;
}

export interface Target {
  store: Store;
  kind: "dir" | "archil" | "mount";
  /** For Archil targets, the disk's ID. */
  diskId?: string;
  describe: string;
}

/** Resolve the atoll a command acts on. `--dir`, `--disk` and `--mounted` win; then the project's settings. */
export async function resolveTarget(flags: TargetFlags, project: Project | null, name?: string): Promise<Target> {
  if (flags.mounted) {
    const store = new LocalStore(resolve(flags.mounted), { archilMount: resolve(flags.mounted) });
    return { store, kind: "mount", describe: `the Archil disk mounted at ${flags.mounted}` };
  }
  if (flags.dir) return { store: new LocalStore(resolve(flags.dir)), kind: "dir", describe: `the local atoll in ${flags.dir}` };
  const disk = flags.disk ?? project?.disk;
  if (disk) {
    const { ArchilStore } = await import("../store/archil.ts");
    const store = await ArchilStore.open({ disk, ...(flags.prefix ?? project?.prefix ? { prefix: flags.prefix ?? project?.prefix } : {}) });
    return { store, kind: "archil", diskId: store.diskId, describe: `Archil disk ${store.diskId}${store.prefix ? ` at ${store.prefix}` : ""}` };
  }
  if (project) {
    // A project's local atoll is .atoll-local/ at its root (gitignored), unless package.json says otherwise.
    void name;
    const dir = project.dir ?? join(project.root, ".atoll-local");
    return { store: new LocalStore(dir), kind: "dir", describe: `the local atoll in ${dir}` };
  }
  throw new NotInProject();
}
