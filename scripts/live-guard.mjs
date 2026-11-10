// Live check of `atoll create` against real Archil disks: a fresh disk lays out without asking, a disk
// that already has files is shown and left alone, --prefix and --alongside go ahead without touching
// what was there. Uses two disks (deleted at the end) and no exec calls. Prints no credentials.
// Run from an empty directory, with ARCHIL_API_KEY and ARCHIL_REGION set: node <repo>/scripts/live-guard.mjs

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Archil } from "disk";

const CLI = fileURLToPath(new URL("../dist/atoll.mjs", import.meta.url));
const archil = new Archil({ apiKey: process.env.ARCHIL_API_KEY, region: process.env.ARCHIL_REGION });
const created = [];

function atoll(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  console.log(`$ atoll ${args.join(" ")}   (exit ${r.status})`);
  for (const line of `${r.stdout}${r.stderr}`.trimEnd().split("\n")) console.log(`  ${line}`);
  return r;
}

function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
}

try {
  console.log("== a brand-new disk: nothing at its root, so create lays out without asking");
  const fresh = atoll("create", "guard-fresh", "--disk", "atoll-guard-fresh");
  const freshDisk = (await archil.disks.list()).find((d) => d.name === "atoll-guard-fresh");
  if (freshDisk) created.push(freshDisk);
  check("a fresh disk is laid out (exit 0)", fresh.status === 0 && /Created the atoll/.test(fresh.stdout));

  console.log("\n== a disk that already has someone's files");
  const { disk } = await archil.disks.create({ name: "atoll-guard-existing" });
  created.push(disk);
  await disk.putObject("notes.txt", "mine\n");
  await disk.putObject("memory/keep.md", "keep\n");
  const refused = atoll("create", "guard", "--disk", disk.id);
  check("create refuses, exit 1", refused.status === 1);
  check("and shows the top level: memory/ and notes.txt", /Its top level:\n {2}memory\/\n {2}notes\.txt\n/.test(refused.stdout));
  check("and laid nothing out", (await disk.listObjects(".atoll/", { recursive: true })).objects.length === 0);

  console.log("");
  const prefixed = atoll("create", "guard", "--disk", disk.id, "--prefix", "atolls/guard");
  check("--prefix lays the atoll out in its own folder (exit 0)", prefixed.status === 0);
  check("under atolls/guard/", Boolean(await disk.headObject("atolls/guard/.atoll/format")));

  console.log("");
  const alongside = atoll("create", "guard", "--disk", disk.id, "--alongside");
  check("--alongside lays it out at the root (exit 0)", alongside.status === 0);
  check("and notes.txt is untouched", new TextDecoder().decode(await disk.getObject("notes.txt")) === "mine\n");
  check("and memory/keep.md is untouched", new TextDecoder().decode(await disk.getObject("memory/keep.md")) === "keep\n");

  console.log("");
  const again = atoll("create", "guard", "--disk", disk.id);
  check("once it is an atoll, create just finds it (exit 0)", again.status === 0 && /Found the atoll/.test(again.stdout));
  atoll("ls", "--disk", disk.id);
} finally {
  for (const d of created) await d.delete();
  const left = (await archil.disks.list()).map((d) => d.name);
  console.log(`\nDeleted ${created.map((d) => d.name).join(", ")}. Disks left on the account: ${left.join(", ")}.`);
}
