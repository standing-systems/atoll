#!/usr/bin/env node
// atoll for Codex. Prefers the nearest project's installed Atoll (node_modules/@standing-systems/atoll), so the agent, CI,
// and the person run the same version; otherwise runs the plugin's bundled build, ../dist/atoll.mjs.
// Never contacts the network itself.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error(`atoll: Node.js 22.19 or later is required (this is ${process.version})`);
  process.exit(127);
}

/** The project's pinned CLI: the nearest node_modules/@standing-systems/atoll whose package declares an atoll bin. */
function projectPin(cwd) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const pkg = join(dir, "node_modules", "@standing-systems", "atoll", "package.json");
    if (existsSync(pkg)) {
      try {
        const data = JSON.parse(readFileSync(pkg, "utf8"));
        const bin = typeof data.bin === "string" ? data.bin : data.bin?.atoll;
        if (data.name === "@standing-systems/atoll" && typeof bin === "string") {
          const entry = resolve(dirname(pkg), bin);
          // Never select this plugin's own files, even through a symlink.
          if (existsSync(entry) && !realpathSync(entry).startsWith(realpathSync(pluginRoot) + sep)) return entry;
        }
      } catch {
        // An unreadable package.json is not a pin; keep looking further up.
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

const pinned = projectPin(process.cwd());
const entry = pinned ?? join(pluginRoot, "dist", "atoll.mjs");
if (!existsSync(entry)) {
  console.error(
    `atoll: the plugin's CLI isn't built (${entry} is missing). Point this project's @standing-systems/atoll devDependency at a checkout of Atoll (file:/path/to/atoll), or run npm run build in the Atoll repository.`,
  );
  process.exit(127);
}

const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    ATOLL_HOST: "codex",
    ATOLL_LAUNCHER: pinned ? "project-pin" : "plugin-bundle",
    ATOLL_PLUGIN_DIST: join(pluginRoot, "dist"),
  },
});
if (result.error) {
  console.error(`atoll: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
