#!/usr/bin/env node
// node scripts/validate-plugins.mjs: checks the Claude Code and Codex plugins, both marketplaces, and the
// project templates `atoll init` copies. Each check prints pass, FAIL, or blocked. A check that can't run
// (no `claude` on PATH, the CLI not built yet) is blocked, and blocked is never a pass. Exit 0 only when
// every check passed, 1 when any failed, and 2 when none failed but some were blocked.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const at = (...parts) => join(root, ...parts);
const rel = (path) => relative(root, path) || ".";
const read = (path) => readFileSync(path, "utf8");
const readJson = (path) => JSON.parse(read(path));

const CLAUDE_SKILLS = ["build", "design", "evolve", "inspect", "run", "start"];
const CODEX_SKILLS = ["build-atoll", "design-atoll", "evolve-atoll", "inspect-atoll", "run-atoll", "setup-atoll-project"];
const AGENTS = ["effect-auditor", "part-critic"];
const CLAUDE_SKILL_KEYS = new Set(["name", "description", "allowed-tools", "paths"]);
const CODEX_SKILL_KEYS = new Set(["name", "description"]);
const AGENT_KEYS = new Set(["name", "description", "tools", "maxTurns"]);
/** Shell commands a skill may pre-approve in allowed-tools: they only read. */
const READ_ONLY_SHELL = new Set(["ls", "cat", "head", "tail", "grep"]);
const PLUGIN_ATOLL = '"${CLAUDE_PLUGIN_ROOT}/bin/atoll"';
const EM_DASH = String.fromCharCode(0x2014);

const contract = readJson(at("scripts", "atoll-commands.json"));
const commands = new Map(contract.commands.map((c) => [c.name, c]));

let Ajv2020 = null;
try {
  ({ default: Ajv2020 } = await import("ajv/dist/2020.js"));
} catch {
  Ajv2020 = null;
}

// ---- reporting ----------------------------------------------------------------------------------------

const results = [];
function check(name, fn) {
  let verdict;
  try {
    verdict = fn();
  } catch (error) {
    verdict = { status: "fail", problems: [String(error?.message ?? error)] };
  }
  results.push({ name, ...verdict });
  const mark = verdict.status === "pass" ? "pass   " : verdict.status === "blocked" ? "blocked" : "FAIL   ";
  console.log(`${mark} ${name}${verdict.detail ? `: ${verdict.detail}` : ""}`);
  for (const problem of verdict.problems ?? []) console.log(`          ${problem.split("\n").join("\n          ")}`);
}
const verdictOf = (problems, detail) => (problems.length ? { status: "fail", problems } : { status: "pass", detail });
const blocked = (detail) => ({ status: "blocked", detail });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024, ...options });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, stdout: result.stdout ?? "", error: result.error };
}
const onPath = (command) => spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0;
const tail = (text, lines = 25) => text.trim().split("\n").slice(-lines).join("\n");

function walk(dir, skip = /(^|\/)(node_modules|dist|\.git)(\/|$)/) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => !skip.test(name))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

// ---- frontmatter and markdown -------------------------------------------------------------------------

/** Simple `key: value` frontmatter, read the way a strict YAML parser would read it. */
function frontmatter(path) {
  const text = read(path);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return { meta: {}, body: text, problems: [`${rel(path)}: no frontmatter`] };
  const meta = {};
  const problems = [];
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z][\w-]*): (.*)$/.exec(line);
    if (!kv) {
      problems.push(`${rel(path)}: frontmatter line isn't "key: value": ${line}`);
      continue;
    }
    const [, key, raw] = kv;
    let value = raw;
    if (key in meta) problems.push(`${rel(path)}: "${key}" appears twice`);
    if (raw.startsWith("[") || raw.startsWith('"')) {
      try {
        value = JSON.parse(raw);
      } catch {
        problems.push(`${rel(path)}: ${key} isn't a valid flow value: ${raw}`);
      }
    } else if (/: |\s#|^[`@%&*!|>'{]/.test(raw)) {
      problems.push(`${rel(path)}: ${key} contains ": ", " #", or a leading indicator, which strict YAML reads as structure; rephrase it`);
    }
    meta[key] = value;
  }
  return { meta, body: text.slice(match[0].length), problems };
}

function checkNameAndDescription(path, meta, expectedName) {
  const problems = [];
  if (meta.name !== expectedName) problems.push(`${rel(path)}: name is "${meta.name}", expected "${expectedName}"`);
  if (typeof meta.name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.name) || meta.name.length > 64) problems.push(`${rel(path)}: name must be 1 to 64 lowercase letters, digits, and single hyphens`);
  if (typeof meta.description !== "string" || !meta.description.trim()) problems.push(`${rel(path)}: description is missing`);
  else {
    if (meta.description.length > 1024) problems.push(`${rel(path)}: description is ${meta.description.length} characters; the limit is 1024`);
    if (/[<>]/.test(meta.description)) problems.push(`${rel(path)}: description contains < or >`);
  }
  return problems;
}

/** The pieces of a markdown file that can hold a command: fenced blocks other than code, inline code, Bash rules. */
function commandText(markdown) {
  const pieces = [];
  const rest = markdown.replace(/^```(\w*)\n([\s\S]*?)^```/gm, (_, lang, body) => {
    if (!/^(ts|tsx|typescript|js|mjs|javascript|json)$/.test(lang)) pieces.push(body);
    return "";
  });
  for (const m of rest.matchAll(/`([^`\n]+)`/g)) pieces.push(m[1]);
  for (const m of rest.matchAll(/Bash\(([^)]*)\)/g)) pieces.push(m[1]);
  return pieces;
}

const ATOLL_COMMAND = /(?:^|[\s;&|(!`])(?:npx\s+(?:--no-install\s+)?)?(?:"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/atoll"|atoll)[ \t]+([a-z][a-z-]*)(?:[ \t]+([a-z][a-z-]*))?/g;

/** Every `atoll <command> [<subcommand>]` a markdown file names. */
function namedCommands(markdown) {
  const found = [];
  for (const piece of commandText(markdown)) {
    for (const m of piece.matchAll(ATOLL_COMMAND)) found.push({ command: m[1], sub: m[2] });
  }
  return found;
}

/** Tools in an allowed-tools value: `Read`, `Bash(atoll check *)`, `Bash("${CLAUDE_PLUGIN_ROOT}/bin/atoll" status *)`. */
function allowedTools(value) {
  const tools = [];
  for (const m of String(value ?? "").matchAll(/([A-Za-z]+)(?:\(([^)]*)\))?/g)) tools.push({ tool: m[1], arg: m[2] });
  return tools;
}

/** Why a Bash rule in allowed-tools isn't read-only, or null when it is. */
function notReadOnly(arg, { verifySkill }) {
  let command = arg.trim().replace(/\s+\*$/, "");
  command = command.replace(PLUGIN_ATOLL, "atoll").replace(/^npx\s+(--no-install\s+)?/, "");
  const words = command.split(/\s+/);
  if (words[0] === "atoll") {
    const spec = commands.get(words[1] ?? "");
    if (!spec) return `"${arg}" names an atoll command that isn't in scripts/atoll-commands.json`;
    if (!spec.readOnly) return `"${arg}" pre-approves atoll ${words[1]}, which changes things; allowed-tools lists only read-only commands`;
    return null;
  }
  if (verifySkill && command === "npm run verify") return null;
  if (words.length === 1 && READ_ONLY_SHELL.has(words[0])) return null;
  return `"${arg}" isn't a read-only command`;
}

// ---- the Claude Code CLI's own checks -----------------------------------------------------------------

check("claude plugin validate --strict plugins/claude", () => {
  if (!onPath("claude")) return blocked("`claude` is not on PATH");
  const r = run("claude", ["plugin", "validate", "--strict", "plugins/claude"]);
  return r.code === 0 ? { status: "pass", detail: "Validation passed" } : { status: "fail", problems: [tail(r.out)] };
});

check("claude plugin validate --strict . (the marketplace)", () => {
  if (!onPath("claude")) return blocked("`claude` is not on PATH");
  const r = run("claude", ["plugin", "validate", "--strict", "."]);
  return r.code === 0 ? { status: "pass", detail: "Validation passed" } : { status: "fail", problems: [tail(r.out)] };
});

check("always-on cost of the Claude Code plugin", () => {
  if (!onPath("claude")) return blocked("`claude` is not on PATH");
  const r = run("claude", ["--plugin-dir", "plugins/claude", "plugin", "details", "atoll"]);
  const m = /Always-on:\s*~?([\d.,]+)\s*(k)?\s*tok/i.exec(r.out);
  const tokens = m ? Math.round(Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1)) : Number.NaN;
  if (!Number.isFinite(tokens) || tokens <= 0) return blocked(`couldn't read the projected cost from \`claude plugin details\`: ${tail(r.out, 3)}`);
  if (tokens > 1500) return { status: "fail", problems: [`about ${tokens} tokens are added to every session; the ceiling is 1,500`] };
  return { status: "pass", detail: `about ${tokens} tokens in every session${tokens > 1000 ? ", over the 1,000 target" : ", under the 1,000 target"}` };
});

// ---- manifests and marketplaces -----------------------------------------------------------------------

check("Codex plugin.json against docs/codex-plugin.schema.json", () => {
  if (!Ajv2020) return blocked("ajv is not installed (npm install)");
  const manifestPath = at("plugins", "codex", "plugin.json");
  const manifest = readJson(manifestPath);
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(readJson(at("docs", "codex-plugin.schema.json")));
  const problems = [];
  if (!validate(manifest)) for (const e of validate.errors ?? []) problems.push(`plugin.json${e.instancePath || ""} ${e.message}`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) problems.push("plugin.json: version must be strict SemVer (x.y.z)");
  const openai = manifest.extensions?.["com.openai"];
  const onboarding = openai?.onboardingSkill;
  if (onboarding !== "./skills/setup-atoll-project/SKILL.md") problems.push(`plugin.json: onboardingSkill is "${onboarding}", expected "./skills/setup-atoll-project/SKILL.md"`);
  else if (!existsSync(resolve(dirname(manifestPath), onboarding))) problems.push("plugin.json: the onboarding skill doesn't exist");
  if (!openai?.interface?.displayName) problems.push("plugin.json: extensions.com.openai.interface.displayName is missing");
  for (const forbidden of ["hooks", ".mcp.json", "mcp.json"]) if (existsSync(at("plugins", "codex", forbidden))) problems.push(`plugins/codex/${forbidden}: the Codex plugin needs no hooks or MCP server`);
  return verdictOf(problems, "Agent Plugins 1.0.0, strict SemVer, onboarding skill present");
});

check("marketplaces", () => {
  const problems = [];
  const claude = readJson(at(".claude-plugin", "marketplace.json"));
  const claudeEntry = claude.plugins?.find((p) => p.name === "atoll");
  if (claude.name !== "atoll") problems.push(".claude-plugin/marketplace.json: name should be \"atoll\"");
  if (!claudeEntry) problems.push(".claude-plugin/marketplace.json: no plugin named atoll");
  else if (claudeEntry.source !== "./plugins/claude" || !existsSync(at("plugins", "claude", ".claude-plugin", "plugin.json"))) problems.push(".claude-plugin/marketplace.json: atoll's source should be ./plugins/claude, with a .claude-plugin/plugin.json");
  const codex = readJson(at(".agents", "plugins", "marketplace.json"));
  const codexEntry = codex.plugins?.find((p) => p.name === "atoll");
  if (codex.name !== "atoll") problems.push(".agents/plugins/marketplace.json: name should be \"atoll\"");
  if (!codexEntry) problems.push(".agents/plugins/marketplace.json: no plugin named atoll");
  else if (codexEntry.source?.source !== "local" || codexEntry.source?.path !== "./plugins/codex" || !existsSync(at("plugins", "codex", "plugin.json"))) problems.push(".agents/plugins/marketplace.json: atoll's source should be { source: local, path: ./plugins/codex }, with a plugin.json there");
  return verdictOf(problems, "atoll from ./plugins/claude and from local ./plugins/codex");
});

check("one version everywhere", () => {
  const versions = {
    "package.json": readJson(at("package.json")).version,
    "plugins/claude/.claude-plugin/plugin.json": readJson(at("plugins", "claude", ".claude-plugin", "plugin.json")).version,
    "plugins/codex/plugin.json": readJson(at("plugins", "codex", "plugin.json")).version,
  };
  for (const host of ["claude", "codex"]) {
    const file = at("plugins", host, "dist", "VERSION");
    if (existsSync(file)) versions[rel(file)] = read(file).trim();
  }
  const distinct = new Set(Object.values(versions));
  return distinct.size === 1 ? { status: "pass", detail: [...distinct][0] } : { status: "fail", problems: Object.entries(versions).map(([f, v]) => `${f}: ${v}`) };
});

// ---- skills, agents, and the hook ---------------------------------------------------------------------

function skillDirs(base) {
  return existsSync(base) ? readdirSync(base).filter((d) => statSync(join(base, d)).isDirectory()).sort() : [];
}

check("Claude Code skills", () => {
  const base = at("plugins", "claude", "skills");
  const dirs = skillDirs(base);
  const problems = [];
  if (dirs.join(",") !== CLAUDE_SKILLS.join(",")) problems.push(`skills are [${dirs.join(", ")}]; expected exactly [${CLAUDE_SKILLS.join(", ")}]`);
  for (const dir of dirs) {
    const path = join(base, dir, "SKILL.md");
    if (!existsSync(path)) {
      problems.push(`${rel(path)} is missing`);
      continue;
    }
    const { meta, body, problems: fm } = frontmatter(path);
    problems.push(...fm, ...checkNameAndDescription(path, meta, dir));
    for (const key of Object.keys(meta)) if (!CLAUDE_SKILL_KEYS.has(key)) problems.push(`${rel(path)}: unexpected frontmatter key "${key}"`);
    const tools = allowedTools(meta["allowed-tools"]);
    for (const { tool, arg } of tools) {
      if (tool === "Bash") {
        const why = notReadOnly(arg ?? "", { verifySkill: false });
        if (why) problems.push(`${rel(path)}: allowed-tools ${why}`);
      } else if (!["Read", "Grep", "Glob"].includes(tool)) problems.push(`${rel(path)}: allowed-tools pre-approves ${tool}, which isn't read-only`);
    }
    // Rules first, then injected evidence, then steps, then an observable end.
    const rules = body.indexOf("Rules that hold for this whole skill:");
    const firstSection = body.search(/^## /m);
    const steps = body.search(/^## Steps/m);
    const end = Math.max(body.lastIndexOf("Done when"), body.search(/^## Output/m));
    if (rules < 0 || (firstSection >= 0 && rules > firstSection)) problems.push(`${rel(path)}: the body should open with "Rules that hold for this whole skill:" before any section`);
    if (end < 0) problems.push(`${rel(path)}: no "Done when" line or "## Output" section`);
    else if (steps >= 0 && end < steps) problems.push(`${rel(path)}: "Done when" or "## Output" should come after the steps`);
    for (const m of body.matchAll(/^!`(.+)`\s*$/gm)) {
      const injection = m[1];
      if (m.index < rules || (steps >= 0 && m.index > steps)) problems.push(`${rel(path)}: the injected evidence should sit between the rules and the steps`);
      if (!/\|\|\s*true$/.test(injection)) problems.push(`${rel(path)}: injection "${injection}" must end with "|| true", or a failing command aborts the skill`);
      const sub = new RegExp(`^${PLUGIN_ATOLL.replace(/[$.{}/]/g, "\\$&")} ([a-z-]+)`).exec(injection)?.[1];
      if (!sub) problems.push(`${rel(path)}: injection "${injection}" should run ${PLUGIN_ATOLL} <command>`);
      else if (!tools.some((t) => t.tool === "Bash" && t.arg === `${PLUGIN_ATOLL} ${sub} *`)) problems.push(`${rel(path)}: allowed-tools lacks Bash(${PLUGIN_ATOLL} ${sub} *) for its injection`);
    }
    const lines = read(path).split("\n").length;
    if (lines > 500) problems.push(`${rel(path)}: ${lines} lines; keep a skill under 500 and move detail into references/`);
  }
  return verdictOf(problems, `${dirs.length} skills: frontmatter, read-only allowed-tools, rules then evidence then steps then done`);
});

check("Codex skills", () => {
  const base = at("plugins", "codex", "skills");
  const dirs = skillDirs(base);
  const problems = [];
  if (dirs.join(",") !== CODEX_SKILLS.join(",")) problems.push(`skills are [${dirs.join(", ")}]; expected exactly [${CODEX_SKILLS.join(", ")}]`);
  const pluginRoot = at("plugins", "codex") + sep;
  for (const dir of dirs) {
    const path = join(base, dir, "SKILL.md");
    if (!existsSync(path)) {
      problems.push(`${rel(path)} is missing`);
      continue;
    }
    const { meta, body, problems: fm } = frontmatter(path);
    problems.push(...fm, ...checkNameAndDescription(path, meta, dir));
    for (const key of Object.keys(meta)) if (!CODEX_SKILL_KEYS.has(key)) problems.push(`${rel(path)}: Codex skills take only name and description, not "${key}"`);
    if (!/^1\. /m.test(body)) problems.push(`${rel(path)}: the body should be numbered steps`);
    if (!body.includes("](references/workflow.md)")) problems.push(`${rel(path)}: doesn't link references/workflow.md`);
    for (const m of body.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https?:\/\//.test(m[1])) continue;
      const target = resolve(dirname(path), m[1]);
      if (!target.startsWith(pluginRoot) || !existsSync(target)) problems.push(`${rel(path)}: link ${m[1]} is missing or outside the plugin`);
    }
  }
  return verdictOf(problems, `${dirs.length} skills: name and description only, numbered steps, links inside the plugin`);
});

check("Codex references/workflow.md copies are identical", () => {
  const copies = CODEX_SKILLS.map((d) => at("plugins", "codex", "skills", d, "references", "workflow.md"));
  const missing = copies.filter((p) => !existsSync(p));
  if (missing.length) return { status: "fail", problems: missing.map((p) => `${rel(p)} is missing`) };
  const first = read(copies[0]);
  const different = copies.slice(1).filter((p) => read(p) !== first);
  return different.length ? { status: "fail", problems: different.map((p) => `${rel(p)} differs from ${rel(copies[0])}; copy it again`) } : { status: "pass", detail: `${copies.length} byte-identical copies` };
});

check("the critics", () => {
  const base = at("plugins", "claude", "agents");
  const files = existsSync(base) ? readdirSync(base).filter((f) => f.endsWith(".md")).sort() : [];
  const problems = [];
  if (files.map((f) => basename(f, ".md")).join(",") !== AGENTS.join(",")) problems.push(`agents are [${files.join(", ")}]; expected [${AGENTS.join(", ")}]`);
  for (const file of files) {
    const path = join(base, file);
    const { meta, problems: fm } = frontmatter(path);
    problems.push(...fm, ...checkNameAndDescription(path, meta, basename(file, ".md")));
    for (const key of Object.keys(meta)) if (!AGENT_KEYS.has(key)) problems.push(`${rel(path)}: unexpected frontmatter key "${key}"`);
    if (meta.tools !== "Read, Grep, Glob") problems.push(`${rel(path)}: tools is "${meta.tools}"; the critics are read-only (Read, Grep, Glob)`);
  }
  return verdictOf(problems, `${files.length} read-only agents`);
});

check("the check-on-edit hook", () => {
  const hooks = readJson(at("plugins", "claude", "hooks", "hooks.json")).hooks ?? {};
  const problems = [];
  const post = hooks.PostToolUse ?? [];
  const entry = post.find((h) => h.matcher === "Write|Edit");
  const hook = entry?.hooks?.[0];
  if (!entry || post.length !== 1 || Object.keys(hooks).length !== 1) problems.push("hooks.json should hold exactly one PostToolUse entry, on Write|Edit");
  if (hook?.type !== "command" || hook?.command !== "${CLAUDE_PLUGIN_ROOT}/bin/atoll" || JSON.stringify(hook?.args) !== '["hook","check-on-edit"]' || hook?.timeout !== 5) problems.push('the hook should run ${CLAUDE_PLUGIN_ROOT}/bin/atoll with args ["hook", "check-on-edit"] and timeout 5');
  return verdictOf(problems, "PostToolUse on Write|Edit runs bin/atoll hook check-on-edit, timeout 5");
});

check("every atoll command a skill names is in scripts/atoll-commands.json", () => {
  const files = [
    ...walk(at("plugins", "claude", "skills")),
    ...walk(at("plugins", "claude", "agents")),
    ...walk(at("plugins", "codex", "skills")),
    ...["CLAUDE.md", "AGENTS.md", ".claude/skills/verify/SKILL.md", ".agents/skills/verify/SKILL.md"].map((f) => at("templates", "project", f)),
  ].filter((p) => p.endsWith(".md") && existsSync(p));
  const problems = [];
  let named = 0;
  for (const path of files) {
    for (const { command, sub } of namedCommands(read(path))) {
      named += 1;
      const spec = commands.get(command);
      if (!spec) problems.push(`${rel(path)}: names "atoll ${command}", which isn't in scripts/atoll-commands.json`);
      else if (spec.subcommands && sub && !spec.subcommands.includes(sub)) problems.push(`${rel(path)}: names "atoll ${command} ${sub}"; its subcommands are ${spec.subcommands.join(", ")}`);
    }
  }
  return verdictOf(problems, `${named} mentions in ${files.length} files, all in the contract`);
});

check("inline code closes on the line it opens", () => {
  // A code span broken across lines hides the command in it from the check above.
  const files = [...walk(at("plugins")), ...walk(at("templates"), /(^|\/)(node_modules)(\/|$)/)].filter((p) => p.endsWith(".md"));
  const problems = [];
  for (const path of files) {
    let fenced = false;
    read(path)
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*```/.test(line)) fenced = !fenced;
        else if (!fenced && (line.match(/`/g) ?? []).length % 2 === 1) problems.push(`${rel(path)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
  }
  return verdictOf(problems, `${files.length} markdown files`);
});

check("no em dashes", () => {
  const files = [
    ...walk(at("plugins")),
    ...walk(at("templates"), /(^|\/)(node_modules)(\/|$)/),
    at(".claude-plugin", "marketplace.json"),
    at(".agents", "plugins", "marketplace.json"),
    at("scripts", "atoll-commands.json"),
    fileURLToPath(import.meta.url),
  ].filter((p) => existsSync(p) && !/\.(png|jpg|tgz)$/.test(p));
  const problems = [];
  for (const path of files) {
    read(path)
      .split("\n")
      .forEach((line, i) => {
        if (line.includes(EM_DASH)) problems.push(`${rel(path)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
  }
  return verdictOf(problems, `${files.length} files`);
});

// ---- templates ----------------------------------------------------------------------------------------

check("project templates", () => {
  const base = at("templates", "project");
  const problems = [];
  const required = ["package.json", "tsconfig.json", "system.ts", "test/system.test.ts", "CHARTER.md", "CLAUDE.md", "AGENTS.md", ".gitignore", ".claude/skills/verify/SKILL.md", ".agents/skills/verify/SKILL.md"];
  for (const file of required) if (!existsSync(join(base, file))) problems.push(`templates/project/${file} is missing`);
  for (const path of walk(base, /^$/)) {
    const name = relative(base, path);
    if (/(^|\/)(\.actord|\.atoll-local|node_modules|\.DS_Store)(\/|$)|\.log$/.test(name)) problems.push(`templates/project/${name} doesn't belong in a template (atoll init would copy it into every project)`);
  }
  if (problems.length) return { status: "fail", problems };
  const pkg = readJson(join(base, "package.json"));
  if (pkg.name !== "__ATOLL_NAME__") problems.push('package.json: name should be "__ATOLL_NAME__", which atoll init replaces');
  if (pkg.devDependencies?.["@standing-systems/atoll"] !== "__ATOLL_DEP__") problems.push('package.json: devDependencies["@standing-systems/atoll"] should be "__ATOLL_DEP__", which atoll init replaces');
  for (const dep of ["vitest", "typescript"]) if (!pkg.devDependencies?.[dep]) problems.push(`package.json: devDependencies lacks ${dep}`);
  if (pkg.scripts?.verify !== "atoll check && vitest run") problems.push('package.json: scripts.verify should be "atoll check && vitest run"');
  if (pkg.scripts?.test !== "vitest run") problems.push('package.json: scripts.test should be "vitest run"');
  if (pkg.atoll?.entry !== "system.ts") problems.push('package.json: "atoll": { "entry": "system.ts" } is missing');
  if (!read(join(base, ".gitignore")).split("\n").includes(".atoll-local/")) problems.push(".gitignore: the local atoll, .atoll-local/, should be ignored");
  const mustHold = [
    [/Never push code, create a disk, start a door, or install a clock/, "never push, create a disk, start a door, or install a clock without the person"],
    [/answer with the plan/, "answer a deploy request with the plan"],
    [/keep the existing tests/, "keep existing tests"],
    [/one focused test/, "add a focused test"],
    [/All I\/O is an effect/, "effects for all I/O"],
    [/never call `fetch`, `Date\.now\(\)`/, "handlers never call fetch or Date.now()"],
    [/`npm test`/, "what npm test establishes"],
    [/atoll check/, "what atoll check establishes"],
    [/`system\.ts`/, "where the declaration lives"],
  ];
  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    const text = read(join(base, file));
    const lines = text.trim().split("\n").length;
    if (lines > 16) problems.push(`${file}: ${lines} lines; project guidance stays around 12`);
    for (const [re, rule] of mustHold) if (!re.test(text)) problems.push(`${file}: doesn't state "${rule}"`);
  }
  for (const [file, keys] of [
    [".claude/skills/verify/SKILL.md", CLAUDE_SKILL_KEYS],
    [".agents/skills/verify/SKILL.md", CODEX_SKILL_KEYS],
  ]) {
    const path = join(base, file);
    const { meta, body, problems: fm } = frontmatter(path);
    problems.push(...fm, ...checkNameAndDescription(path, meta, "verify"));
    for (const key of Object.keys(meta)) if (!keys.has(key)) problems.push(`${rel(path)}: unexpected frontmatter key "${key}"`);
    for (const { tool, arg } of allowedTools(meta["allowed-tools"])) {
      const why = tool === "Bash" ? notReadOnly(arg ?? "", { verifySkill: true }) : `pre-approves ${tool}`;
      if (why) problems.push(`${rel(path)}: allowed-tools ${why}`);
    }
    if (!body.includes("npm run verify")) problems.push(`${rel(path)}: doesn't run npm run verify`);
  }
  return verdictOf(problems, "files present, placeholders, verify script, and the rules that must hold");
});

// ---- code blocks and the template, against the real API ------------------------------------------------

const cache = at("node_modules", ".cache", "atoll-validate");
const tsc = at("node_modules", ".bin", "tsc");
const vitest = at("node_modules", ".bin", "vitest");

/** Write every `// atoll:check [path]` block of one skill (and the template) where tsc and vitest can run them. */
function stageCode() {
  rmSync(cache, { recursive: true, force: true });
  const groups = [
    ...CLAUDE_SKILLS.map((d) => ({ name: `claude-${d}`, files: walk(at("plugins", "claude", "skills", d)) })),
    // The six workflow.md copies are identical (checked above), so one is enough.
    { name: "codex-workflow", files: [at("plugins", "codex", "skills", CODEX_SKILLS[0], "references", "workflow.md")] },
  ];
  let blocks = 0;
  for (const group of groups) {
    let n = 0;
    for (const path of group.files.filter((p) => p.endsWith(".md"))) {
      for (const m of read(path).matchAll(/^```ts\n(\/\/ atoll:check(?: ([^\n]+))?\n[\s\S]*?)^```/gm)) {
        const dest = join(cache, group.name, m[2]?.trim() || `block-${n++}.ts`);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, m[1]);
        blocks += 1;
      }
    }
  }
  // The whole template, as `atoll init` would write it: its test reads CHARTER.md beside system.ts.
  for (const path of walk(at("templates", "project"), /(^|\/)(node_modules|\.atoll-local)(\/|$)/)) {
    const dest = join(cache, "template", relative(at("templates", "project"), path));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, read(path).replaceAll("__ATOLL_NAME__", "my-atoll"));
  }
  writeFileSync(join(cache, "tsconfig.json"), JSON.stringify({ extends: at("tsconfig.json"), compilerOptions: { typeRoots: [at("node_modules", "@types")] }, include: [join(cache, "**", "*.ts")] }, null, 2));
  writeFileSync(
    join(cache, "vitest.config.mjs"),
    `export default {
  resolve: { alias: [{ find: /^@standing-systems\\/atoll\\/testing$/, replacement: ${JSON.stringify(at("src", "testing.ts"))} }, { find: /^@standing-systems\\/atoll$/, replacement: ${JSON.stringify(at("src", "index.ts"))} }] },
  test: { root: ${JSON.stringify(cache)}, include: ["**/test/**/*.test.ts"], environment: "node", testTimeout: 30000 },
};
`,
  );
  return blocks;
}

let staged = null;
check("code blocks in skills and the template typecheck against src/", () => {
  for (const need of [at("src", "index.ts"), at("src", "testing.ts")]) if (!existsSync(need)) return blocked(`${rel(need)} doesn't exist yet`);
  if (!existsSync(tsc)) return blocked("TypeScript isn't installed (npm install)");
  staged = stageCode();
  const r = run(tsc, ["-p", join(cache, "tsconfig.json"), "--noEmit"]);
  return r.code === 0 ? { status: "pass", detail: `${staged} checked blocks and the template's system.ts and test` } : { status: "fail", problems: [tail(r.out, 30)] };
});

check("tests in skills and the template pass against the runtime", () => {
  if (staged === null) return blocked("the typecheck above didn't stage the code");
  if (!existsSync(vitest)) return blocked("vitest isn't installed (npm install)");
  const r = run(vitest, ["run", "--config", join(cache, "vitest.config.mjs")]);
  const summary = /Tests\s+(.+)/.exec(r.out)?.[1]?.trim();
  return r.code === 0 ? { status: "pass", detail: summary ?? "passed" } : { status: "fail", problems: [tail(r.out, 40)] };
});

// ---- the launchers and the built CLI ------------------------------------------------------------------

const bundle = at("plugins", "claude", "dist", "atoll.mjs");

check("launchers", () => {
  const problems = [];
  const sh = at("plugins", "claude", "bin", "atoll");
  const js = at("plugins", "codex", "bin", "atoll.js");
  for (const path of [sh, js]) {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      problems.push(`${rel(path)} isn't executable`);
    }
  }
  if (run("sh", ["-n", sh]).code !== 0) problems.push(`${rel(sh)} isn't valid sh`);
  if (run(process.execPath, ["--check", js]).code !== 0) problems.push(`${rel(js)} doesn't parse`);
  for (const host of ["claude", "codex"]) if (!existsSync(at("plugins", host, "dist", ".gitkeep"))) problems.push(`plugins/${host}/dist/.gitkeep is missing`);
  const off = run(sh, ["hook", "check-on-edit"], { input: "{}", env: { ...process.env, CLAUDE_PLUGIN_OPTION_CHECK_ON_EDIT: "false" } });
  if (off.code !== 0 || off.stdout !== "") problems.push("with check_on_edit off, the hook should print nothing and exit 0");
  if (problems.length) return { status: "fail", problems };
  if (!existsSync(bundle)) return blocked("plugins/*/dist/atoll.mjs isn't built yet (npm run build); syntax, modes, and the hook switch passed");
  const empty = mkdtempSync(join(tmpdir(), "atoll-launch-"));
  try {
    for (const [label, command, args] of [
      ["bin/atoll", sh, ["doctor", "--json"]],
      ["bin/atoll.js", process.execPath, [js, "doctor", "--json"]],
    ]) {
      const r = run(command, args, { cwd: empty });
      let doc;
      try {
        doc = JSON.parse(r.stdout);
      } catch {
        doc = null;
      }
      if (doc?.command !== "doctor") problems.push(`${label} doctor --json from an empty directory printed no doctor report: ${tail(r.out, 3)}`);
    }
    const quiet = run(sh, ["hook", "check-on-edit"], { cwd: empty, input: JSON.stringify({ tool_input: { file_path: join(empty, "notes.md") } }) });
    if (quiet.code !== 0 || quiet.stdout !== "") problems.push("the hook should stay silent and exit 0 for a file outside an atoll project");
    const broken = join(empty, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "system.ts"), 'export default { name: "broken", parts: { a: { purpose: "", on: { "a.b": () => {} } } } };\n');
    const loud = run(sh, ["hook", "check-on-edit"], { cwd: broken, input: JSON.stringify({ tool_input: { file_path: join(broken, "system.ts") } }) });
    let context = "";
    try {
      context = JSON.parse(loud.stdout).hookSpecificOutput?.additionalContext ?? "";
    } catch {
      context = "";
    }
    if (loud.code !== 0 || !context.includes("NO_PURPOSE")) problems.push(`the hook should report NO_PURPOSE for a part without a purpose, as PostToolUse additionalContext, and exit 0: ${tail(loud.out, 3)}`);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  return verdictOf(problems, "both run the CLI from an empty directory; the hook is silent when clean and reports hard errors");
});

check("the CLI knows every command in scripts/atoll-commands.json", () => {
  if (!existsSync(bundle)) return blocked("plugins/claude/dist/atoll.mjs isn't built yet (npm run build)");
  const r = run(process.execPath, [bundle, "help", "--json"]);
  let names;
  try {
    names = new Set(JSON.parse(r.stdout).commands.map((c) => c.name));
  } catch {
    return blocked(`\`atoll help --json\` printed no command table: ${tail(r.out, 3)}`);
  }
  const missing = [...commands.keys()].filter((name) => !names.has(name));
  const extra = [...names].filter((name) => !commands.has(name));
  if (missing.length) return { status: "fail", problems: [`the CLI has no ${missing.join(", ")}`] };
  return { status: "pass", detail: `${commands.size} commands${extra.length ? `; the CLI also has ${extra.join(", ")}, which skills may not name` : ""}` };
});

// ---- verdict ------------------------------------------------------------------------------------------

const failed = results.filter((r) => r.status === "fail");
const stuck = results.filter((r) => r.status === "blocked");
console.log("");
if (failed.length) console.log(`FAIL: ${failed.length} of ${results.length} checks failed${stuck.length ? `, ${stuck.length} blocked` : ""}.`);
else if (stuck.length) console.log(`blocked: ${results.length - stuck.length} of ${results.length} checks passed; ${stuck.length} couldn't run, which is not a pass.`);
else console.log(`pass: all ${results.length} checks passed.`);
process.exit(failed.length ? 1 : stuck.length ? 2 : 0);
