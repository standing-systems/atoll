// Checkpoints and branches for a local atoll, by copying the directory. Archil's are copy-on-write and
// take milliseconds whatever the size; these are for development and tests of the same semantics.

import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LocalStore } from "./local.ts";
import type { ExecOutcome, ExecRequest, Hands, Snapshots, Store } from "./types.ts";
import { execFile } from "node:child_process";
import { commandEnv } from "../command-env.ts";

/**
 * A LocalStore with hands: commands run in a shell in (a scoped subdirectory of) its directory, with an
 * environment that carries none of the runner's keys, like Archil's exec.
 */
export class LocalHandsStore extends LocalStore implements Hands {
  async exec(request: ExecRequest): Promise<ExecOutcome> {
    const dir = request.scope ? join(this.root, ...request.scope.split("/")) : this.root;
    await mkdir(dir, { recursive: true });
    return new Promise((resolve) => {
      execFile("sh", ["-c", request.command], { cwd: dir, env: commandEnv(), maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 0;
        resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }
}

export class LocalSnapshots implements Snapshots {
  readonly root: string;
  private readonly area: string;

  /** `root` is the atoll's directory; snapshots live beside it in `<root>.snapshots/`. */
  constructor(root: string) {
    this.root = root;
    this.area = `${root}.snapshots`;
  }

  async checkpoint(name: string): Promise<void> {
    const target = join(this.area, "checkpoints", name);
    await mkdir(join(this.area, "checkpoints"), { recursive: true });
    const existing = await readdir(join(this.area, "checkpoints"));
    if (existing.includes(name)) throw new Error(`Checkpoint ${name} already exists`);
    await cp(this.root, target, { recursive: true });
  }

  async branch(name: string, fromCheckpoint: string): Promise<{ id: string; name: string }> {
    const source = join(this.area, "checkpoints", fromCheckpoint);
    const target = join(this.area, "branches", name);
    await mkdir(join(this.area, "branches"), { recursive: true });
    if ((await readdir(join(this.area, "branches"))).includes(name)) throw new Error(`Branch ${name} already exists`);
    await cp(source, target, { recursive: true });
    return { id: target, name };
  }

  async open(diskId: string): Promise<Store & Hands> {
    return new LocalHandsStore(diskId);
  }

  async readAt(checkpoint: string, key: string): Promise<Uint8Array | null> {
    return new LocalStore(join(this.area, "checkpoints", checkpoint)).get(key);
  }
}
