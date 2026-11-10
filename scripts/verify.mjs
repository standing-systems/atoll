// npm run verify: every check that needs no Archil account, in order, with a verdict per gate.
// A gate that can't run reports "blocked", which is never a pass. Exit 0 only when every gate passed.
// With --live, also runs the Archil tests (they need ARCHIL_API_KEY and ARCHIL_REGION, and delete what they create).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");

function run(command, args, env = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, ms: Date.now() - started };
}

const gates = [];
function gate(name, fn) {
  const verdict = fn();
  gates.push({ name, ...verdict });
  const mark = verdict.status === "pass" ? "pass   " : verdict.status === "blocked" ? "blocked" : "FAIL   ";
  console.log(`${mark} ${name}${verdict.detail ? `: ${verdict.detail}` : ""}`);
  if (verdict.status === "fail" && verdict.log) console.log(verdict.log.split("\n").slice(-40).join("\n"));
}

gate("typecheck", () => {
  const r = run("npx", ["--no-install", "tsc", "--noEmit", "-p", "tsconfig.json"]);
  return r.code === 0 ? { status: "pass", detail: `strict TypeScript over src, tests and examples (${r.ms} ms)` } : { status: "fail", log: r.out };
});

gate("build", () => {
  const r = run("node", ["build.mjs"]);
  return r.code === 0 ? { status: "pass", detail: r.out.trim().split("\n").at(-1) } : { status: "fail", log: r.out };
});

gate("tests", () => {
  const r = run("npx", ["--no-install", "vitest", "run", "--reporter=dot"]);
  const summary = r.out.match(/Tests\s+(.+)/)?.[1]?.trim() ?? "";
  const files = r.out.match(/Test Files\s+(.+)/)?.[1]?.trim() ?? "";
  return r.code === 0 ? { status: "pass", detail: `${summary}; files ${files}` } : { status: "fail", detail: summary, log: r.out };
});

gate("plugins", () => {
  if (!existsSync(join(root, "scripts", "validate-plugins.mjs"))) return { status: "blocked", detail: "scripts/validate-plugins.mjs is missing" };
  const r = run("node", ["scripts/validate-plugins.mjs"]);
  if (r.code === 0) return { status: /blocked/i.test(r.out) ? "blocked" : "pass", detail: r.out.trim().split("\n").at(-1) };
  return { status: "fail", log: r.out };
});

gate("cli contract", () => {
  const help = run("node", ["dist/atoll.mjs", "help", "--json"]);
  if (help.code !== 0) return { status: "fail", log: help.out };
  const names = new Set(JSON.parse(help.out).commands.map((c) => c.name));
  const contractPath = join(root, "scripts", "atoll-commands.json");
  if (!existsSync(contractPath)) return { status: "blocked", detail: "scripts/atoll-commands.json is missing" };
  const raw = JSON.parse(readFileSync(contractPath, "utf8"));
  const list = Array.isArray(raw) ? raw : (raw.commands ?? []);
  const wanted = list.map((c) => String(typeof c === "string" ? c : c.name).split(" ")[0]);
  const missing = wanted.filter((w) => !names.has(w));
  return missing.length ? { status: "fail", detail: `commands the skills use but the CLI lacks: ${missing.join(", ")}` } : { status: "pass", detail: `all ${wanted.length} commands the skills name exist` };
});

gate("no em dashes in prose", () => {
  const files = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"]).out.split("\n").filter((f) => f && !f.startsWith("docs/research/"));
  const offenders = files.filter((f) => existsSync(join(root, f)) && readFileSync(join(root, f), "utf8").includes("—"));
  return offenders.length ? { status: "fail", detail: `em dashes in ${offenders.join(", ")}` } : { status: "pass", detail: `${files.length} Markdown files` };
});

if (live) {
  gate("live Archil tests", () => {
    if (!process.env.ARCHIL_API_KEY || !process.env.ARCHIL_REGION) return { status: "blocked", detail: "ARCHIL_API_KEY and ARCHIL_REGION are not set" };
    const r = run("npx", ["--no-install", "vitest", "run", "test/live", "--reporter=dot"], { ATOLL_LIVE: "1" });
    const summary = r.out.match(/Tests\s+(.+)/)?.[1]?.trim() ?? "";
    return r.code === 0 ? { status: "pass", detail: summary } : { status: "fail", detail: summary, log: r.out };
  });
}

const failed = gates.filter((g) => g.status === "fail");
const blocked = gates.filter((g) => g.status === "blocked");
console.log("");
console.log(failed.length ? `verify: FAIL (${failed.map((g) => g.name).join(", ")})` : blocked.length ? `verify: blocked (${blocked.map((g) => g.name).join(", ")}); every other gate passed` : `verify: pass (${gates.length} gates)`);
process.exit(failed.length || blocked.length ? 1 : 0);
