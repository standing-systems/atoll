// Code on the disk. `atoll push` bundles a project's system.ts into one ESM file and stores it under
// .atoll/code/<version>/, so any runner holding the disk's ID runs the same code (section 6.11).

import { mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Hex } from "../ids.ts";
import { FORMAT, paths, type JournalRecord, type Manifest, type WaitOp, type WriteOp } from "../format.ts";
import { asText, type Store } from "../store/types.ts";
import type { SystemSpec } from "../system.ts";
import { nextFire } from "./schedule.ts";
import { inlineContent } from "./turn.ts";

export async function currentCodeVersion(store: Store): Promise<string | null> {
  const text = asText(await store.get(paths.codeCurrent))?.trim();
  return text ? text : null;
}

const loaded = new Map<string, SystemSpec>();

/** Load the code an atoll runs from its disk. Cached per version for the life of the process. */
export async function loadCurrentSystem(store: Store): Promise<SystemSpec> {
  const version = await currentCodeVersion(store);
  if (!version) throw new Error(`No code has been pushed to ${store.location} yet. Run \`atoll push\` in the project.`);
  return loadSystemVersion(store, version);
}

export async function loadSystemVersion(store: Store, version: string): Promise<SystemSpec> {
  const cached = loaded.get(version);
  if (cached) return cached;
  const bytes = await store.get(paths.codeBundle(version));
  if (!bytes) throw new Error(`Code version ${version} is missing from ${store.location}`);
  if (sha256Hex(bytes).slice(0, 16) !== version) throw new Error(`Code version ${version} on ${store.location} doesn't match its hash`);
  const dir = join(tmpdir(), "atoll-code");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${version}.mjs`);
  try {
    await access(file);
  } catch {
    await writeFile(file, bytes);
  }
  const module = (await import(pathToFileURL(file).href)) as { default?: SystemSpec };
  if (!module.default) throw new Error(`Code version ${version} has no default export (export default defineSystem({...}))`);
  loaded.set(version, module.default);
  return module.default;
}

/** Load a system.ts (or .js) from a project directly, for local development and tests. */
export async function loadProjectSystem(entry: string): Promise<{ system: SystemSpec; bytes: Uint8Array; version: string }> {
  const { bytes, version } = await bundleSystem(entry);
  const dir = join(tmpdir(), "atoll-code");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${version}.mjs`);
  await writeFile(file, bytes);
  const module = (await import(pathToFileURL(file).href)) as { default?: SystemSpec };
  if (!module.default) throw new Error(`${entry} has no default export (export default defineSystem({...}))`);
  loaded.set(version, module.default);
  return { system: module.default, bytes, version };
}

/** Bundle a project's entry file with esbuild into one self-contained ESM module. */
export async function bundleSystem(entry: string): Promise<{ bytes: Uint8Array; version: string }> {
  let esbuild: typeof import("esbuild");
  try {
    esbuild = await import("esbuild");
  } catch {
    throw new Error("Bundling needs esbuild; run npm install in the project, or add it (npm install --save-dev esbuild)");
  }
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    legalComments: "none",
    logLevel: "silent",
    plugins: [
      {
        // The only runtime import a system needs from Atoll is defineSystem; handlers get the Turn API as
        // an argument. A shim keeps the bundle small and free of the runtime and its dependencies.
        name: "atoll-shim",
        setup(build) {
          build.onResolve({ filter: /^@standing-systems\/atoll$/ }, () => ({ path: "atoll", namespace: "atoll-shim" }));
          build.onLoad({ filter: /.*/, namespace: "atoll-shim" }, () => ({ contents: "export function defineSystem(spec) { return spec; }", loader: "js" }));
        },
      },
    ],
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error(`esbuild produced no output for ${entry}`);
  const bytes = output.contents;
  return { bytes, version: sha256Hex(bytes).slice(0, 16) };
}

export function manifestOf(system: SystemSpec, version: string, at: string): Manifest {
  return {
    format: FORMAT,
    name: system.name,
    code: version,
    pushedAt: at,
    ...(system.owner ? { owner: system.owner } : {}),
    parts: Object.fromEntries(
      Object.entries(system.parts).map(([name, part]) => [
        name,
        {
          purpose: part.purpose,
          instances: Boolean(part.instances),
          handles: Object.keys(part.on).sort(),
          schedules: (part.schedules ?? []).map((s) => ({ ...(s.every ? { every: s.every } : {}), ...(s.cron ? { cron: s.cron } : {}), ...(s.tz ? { tz: s.tz } : {}), send: s.send })),
        },
      ]),
    ),
    effects: Object.fromEntries(
      Object.entries(system.effects ?? {}).map(([name, e]) => [
        name,
        {
          kind: e.kind,
          approval: Boolean(e.approval),
          ...(e.idempotent !== undefined ? { idempotent: e.idempotent } : {}),
          ...(e.budget ? { budget: e.budget } : {}),
          ...(e.allow ? { allow: e.allow } : {}),
          ...(e.kind === "exec" ? { scope: e.scope ?? "workspace", fork: Boolean(e.fork) } : {}),
          ...(e.model ? { model: e.model } : {}),
        },
      ]),
    ),
  };
}

function writeOp(path: string, text: string): WriteOp {
  const bytes = new TextEncoder().encode(text);
  return { path, sha256: sha256Hex(bytes), size: bytes.byteLength, ...inlineContent(bytes) };
}

/** Build the push record's writes and schedule arming for `system` at `version`. */
export async function pushPlan(store: Store, system: SystemSpec, version: string, seq: number, now: Date): Promise<{ writes: WriteOp[]; arm: { address: string; waits: WaitOp[] }[]; previous: string | null }> {
  const previous = await currentCodeVersion(store);
  const writes: WriteOp[] = [writeOp(paths.manifest, `${JSON.stringify(manifestOf(system, version, now.toISOString()), null, 2)}\n`), writeOp(paths.codeCurrent, `${version}\n`)];
  // A declared charter is the owner's words in the code, so push keeps CHARTER.md in step with it; without
  // one, the disk's CHARTER.md (written by hand or by create) is left alone.
  const existing = asText(await store.get(paths.charter));
  if (system.charter ? existing !== charterText(system) : existing === null) writes.push(writeOp(paths.charter, charterText(system)));
  const arm: { address: string; waits: WaitOp[] }[] = [];
  for (const [name, part] of Object.entries(system.parts)) {
    if (part.instances || !part.schedules?.length) continue;
    arm.push({
      address: name,
      waits: part.schedules.map((s, index) => ({ id: `s${seq}.${index}`, until: nextFire(s, now, system.owner?.timezone).toISOString(), reason: `the next scheduled ${s.send}`, schedule: index })),
    });
  }
  return { writes, arm, previous };
}

export function charterText(system: SystemSpec): string {
  const parts = Object.entries(system.parts).map(([name, p]) => `- **${name}**: ${p.purpose}.`);
  return `# ${system.name}\n\n${system.charter ?? "(Say here, in your own words, what this atoll is for and what it must never do.)"}\n\n## Parts\n\n${parts.join("\n")}\n`;
}

export type PushRecordInput = Omit<Extract<JournalRecord, { kind: "push" }>, "v" | "seq" | "epoch" | "at" | "crc">;
