// Wraps a Store and fails on a chosen mutating operation, so tests can crash a runner at every point
// of a turn and check that recovery reaches the same state as a clean run.

import type { Store, StoreEntry } from "./types.ts";

export class CrashError extends Error {
  readonly op: number;
  readonly what: string;
  constructor(op: number, what: string) {
    super(`injected crash at mutating operation ${op} (${what})`);
    this.name = "CrashError";
    this.op = op;
    this.what = what;
  }
}

export type MutatingOp = "put" | "create" | "append" | "delete";

export class FaultyStore implements Store {
  readonly location: string;
  /** Mutating operations seen so far. */
  ops = 0;
  /** Crash on this mutating operation (1-based). Undefined means never. */
  crashAt: number | undefined;
  /** When true, a crashing op is applied before the error is thrown (the write landed, the reply was lost). */
  applyThenCrash = false;
  /** Every mutating operation, in order, for debugging. */
  readonly trace: string[] = [];
  /** After an injected crash, the "process" is dead: mutating operations it starts throw, until reset(). */
  crashed = false;
  private readonly inflight = new Set<Promise<unknown>>();

  readonly inner: Store;
  constructor(inner: Store) {
    this.inner = inner;
    this.location = `faulty:${inner.location}`;
  }

  private async mutate<T>(what: MutatingOp, key: string, run: () => Promise<T>): Promise<T> {
    this.ops += 1;
    const label = `${what} ${key}`;
    this.trace.push(label);
    if (this.crashed) throw new CrashError(this.ops, `${label} (after the crash)`);
    if (this.crashAt !== undefined && this.ops === this.crashAt) {
      this.crashed = true;
      if (this.applyThenCrash) await this.track(run());
      throw new CrashError(this.ops, label);
    }
    return this.track(run());
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise);
    void promise.then(
      () => this.inflight.delete(promise),
      () => this.inflight.delete(promise),
    );
    return promise;
  }

  /** Wait for operations that were in flight when the crash happened: like a dead process, they land or not. */
  async settle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** Bring the store back for a new runner after a crash. */
  async reset(): Promise<void> {
    await this.settle();
    this.crashed = false;
    this.crashAt = undefined;
  }

  get(key: string): Promise<Uint8Array | null> {
    return this.inner.get(key);
  }
  head(key: string): Promise<StoreEntry | null> {
    return this.inner.head(key);
  }
  list(prefix: string): Promise<StoreEntry[]> {
    return this.inner.list(prefix);
  }
  put(key: string, body: Uint8Array | string): Promise<void> {
    return this.mutate("put", key, () => this.inner.put(key, body));
  }
  create(key: string, body: Uint8Array | string): Promise<boolean> {
    return this.mutate("create", key, () => this.inner.create(key, body));
  }
  append(key: string, body: Uint8Array | string): Promise<void> {
    return this.mutate("append", key, () => this.inner.append(key, body));
  }
  delete(key: string): Promise<void> {
    return this.mutate("delete", key, () => this.inner.delete(key));
  }
  async refresh(): Promise<void> {
    await this.inner.refresh?.();
  }
}
