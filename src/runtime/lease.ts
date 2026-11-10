// One runner at a time. The lease is a directory of epoch objects, each created with a create-only
// write, so exactly one contender wins each epoch. The epoch is the fencing token every journal record
// carries (docs/a-place-to-stand.md, section 7.1).

import { paths } from "../format.ts";
import { asText, type Store } from "../store/types.ts";

export interface LeaseBody {
  epoch: number;
  runner: string;
  acquiredAt: string;
  expiresAt: string;
  released?: boolean;
}

export class LeaseLost extends Error {
  readonly epoch: number;
  constructor(epoch: number) {
    super(`This runner's lease (epoch ${epoch}) was taken over by another runner; stopping before committing anything`);
    this.name = "LeaseLost";
    this.epoch = epoch;
  }
}

/** Clocks of different runners may disagree by this much; an expired lease is taken only after it. */
export const SKEW_MS = 10_000;

export async function currentLease(store: Store): Promise<LeaseBody | null> {
  const entries = await store.list(paths.leasePrefix);
  const last = entries.at(-1);
  if (!last) return null;
  const text = asText(await store.get(last.key));
  if (text === null) return null;
  try {
    return JSON.parse(text) as LeaseBody;
  } catch {
    // A lease object being written right now; treat it as held until it parses.
    const epoch = Number(last.key.slice(paths.leasePrefix.length));
    return { epoch, runner: "unknown", acquiredAt: new Date(0).toISOString(), expiresAt: new Date(8.64e15).toISOString() };
  }
}

export function leaseIsLive(lease: LeaseBody | null, now: Date): boolean {
  if (!lease || lease.released) return false;
  return new Date(lease.expiresAt).getTime() + SKEW_MS > now.getTime();
}

export class Lease {
  private lastRenew: number;
  private readonly store: Store;
  readonly epoch: number;
  readonly runner: string;
  private readonly ttlMs: number;
  private readonly clock: () => Date;
  private body: LeaseBody;

  private constructor(store: Store, epoch: number, runner: string, ttlMs: number, clock: () => Date, body: LeaseBody) {
    this.store = store;
    this.epoch = epoch;
    this.runner = runner;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.body = body;
    this.lastRenew = clock().getTime();
  }

  /** Try to take the lease. Returns null and who holds it when another runner does. */
  static async acquire(
    store: Store,
    options: { runner: string; ttlMs: number; clock: () => Date },
  ): Promise<{ lease: Lease } | { lease: null; heldBy: string; until: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await currentLease(store);
      const now = options.clock();
      if (leaseIsLive(current, now)) return { lease: null, heldBy: current!.runner, until: current!.expiresAt };
      const epoch = (current?.epoch ?? 0) + 1;
      const body: LeaseBody = {
        epoch,
        runner: options.runner,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + options.ttlMs).toISOString(),
      };
      if (await store.create(paths.lease(epoch), JSON.stringify(body))) {
        const lease = new Lease(store, epoch, options.runner, options.ttlMs, options.clock, body);
        await lease.prune();
        return { lease };
      }
      // Another runner won this epoch; look again in case it already released.
    }
    const holder = await currentLease(store);
    return { lease: null, heldBy: holder?.runner ?? "unknown", until: holder?.expiresAt ?? "" };
  }

  /** Extend the lease. Only this runner ever writes its epoch's object. */
  async renew(): Promise<void> {
    const now = this.clock();
    this.body = { ...this.body, expiresAt: new Date(now.getTime() + this.ttlMs).toISOString() };
    await this.store.put(paths.lease(this.epoch), JSON.stringify(this.body));
    this.lastRenew = now.getTime();
  }

  /** Renew if a quarter of the TTL has passed since the last renewal. */
  async maybeRenew(): Promise<void> {
    if (this.clock().getTime() - this.lastRenew > this.ttlMs / 4) await this.renew();
  }

  /**
   * Keep the lease alive while something slow runs: renew it every quarter of the TTL, on a timer, until
   * stopped. A command in a microVM can run for minutes, and a lease left to lapse meanwhile would let a
   * second runner take over and start the same effect.
   */
  keepAlive(): { stop(): Promise<void> } {
    let renewing: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      renewing = renewing.then(() => this.renew()).catch(() => {});
    }, Math.max(50, this.ttlMs / 4));
    timer.unref?.();
    return {
      stop: async () => {
        clearInterval(timer);
        await renewing;
      },
    };
  }

  /** Throw LeaseLost if a later epoch exists. Called immediately before every commit append. */
  async fence(): Promise<void> {
    await this.maybeRenew();
    if (await this.store.head(paths.lease(this.epoch + 1))) throw new LeaseLost(this.epoch);
  }

  async release(): Promise<void> {
    this.body = { ...this.body, released: true, expiresAt: this.clock().toISOString() };
    await this.store.put(paths.lease(this.epoch), JSON.stringify(this.body));
  }

  /** Keep the last few epochs for diagnosis; delete older ones. */
  private async prune(): Promise<void> {
    if (this.epoch <= 8) return;
    const entries = await this.store.list(paths.leasePrefix);
    for (const entry of entries) {
      const epoch = Number(entry.key.slice(paths.leasePrefix.length));
      if (epoch < this.epoch - 5) await this.store.delete(entry.key);
    }
  }
}
