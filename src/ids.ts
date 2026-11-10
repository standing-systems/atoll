// Identifiers. Event IDs are ULIDs (lexical order is time order). IDs a turn creates are derived from
// the turn's sequence number, so re-installing a committed turn after a crash recreates the same IDs.

import { createHash, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > 2 ** 48 - 1) throw new Error(`Time out of range for a ULID: ${ms}`);
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits -> 16 characters of 5 bits each.
  let bits = 0n;
  for (const b of bytes.subarray(0, 10)) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

let lastMs = -1;
let lastRandom: Uint8Array = new Uint8Array(10);

/** A monotonic ULID: strictly increasing within this process even inside one millisecond. */
export function ulid(now: number = Date.now()): string {
  if (now <= lastMs) {
    now = lastMs;
    // Increment the 80-bit randomness as a big-endian counter.
    const next = new Uint8Array(lastRandom);
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i]! < 255) {
        next[i]! += 1;
        break;
      }
      next[i] = 0;
    }
    lastRandom = next;
  } else {
    lastMs = now;
    lastRandom = new Uint8Array(randomBytes(10));
  }
  return encodeTime(now) + encodeRandom(lastRandom);
}

/** A ULID whose time is `ms` and whose randomness is derived from `seed`: the same inputs give the same ID. */
export function derivedUlid(ms: number, seed: string): string {
  return encodeTime(ms) + encodeRandom(createHash("sha256").update(seed).digest());
}

export function isUlid(id: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
}

/** The millisecond timestamp inside a ULID. */
export function ulidTime(id: string): number {
  let ms = 0;
  for (const ch of id.slice(0, 10)) ms = ms * 32 + CROCKFORD.indexOf(ch);
  return ms;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

/** "fx42.0", "q42.1", "n42.0": IDs for what turn `seq` created, by kind and index. */
export function childId(kind: "fx" | "q" | "n", seq: number, index: number): string {
  return `${kind}${seq}.${index}`;
}

/** A random hex string, for runner IDs and nonces. */
export function nonce(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

/** Parse "30s", "15m", "2h", "3d", "1w" into milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/.exec(text.trim());
  if (!match) throw new Error(`Not a duration: "${text}" (use forms like 30s, 15m, 2h, 3d)`);
  const value = Number(match[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as "ms"]!;
  return Math.round(value * unit);
}

/** A Date from a Date, an ISO string, or a duration counted from `now`. */
export function resolveTime(value: Date | string, now: Date): Date {
  if (value instanceof Date) return value;
  if (/^\d+(?:\.\d+)?\s*(ms|s|m|h|d|w)$/.test(value.trim())) return new Date(now.getTime() + parseDuration(value));
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a time or duration: "${value}"`);
  return date;
}
