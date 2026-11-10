# Atoll for Codex

This plugin teaches Codex to design, build, test, run, inspect, and change atolls: standing agents that
live on Archil disks. It shares the CLI and the example systems with the Claude Code plugin in
`../claude`. Version 0.1.0, Apache-2.0 under the repository's [LICENSE](../../LICENSE) and
[NOTICE](../../NOTICE). The design is [A Place to Stand](../../docs/a-place-to-stand.md).

## What it adds

Six skills, each named for what it does:

| Skill | What it is for |
| --- | --- |
| `setup-atoll-project` | The onboarding skill: `atoll doctor`, `atoll init`, and a first passing `npm run verify` |
| `design-atoll` | The parts table, argued down to the fewest parts, and a `CHARTER.md` in the owner's voice |
| `build-atoll` | Handlers and effects in `system.ts`, with tests against a local atoll (`@standing-systems/atoll/testing`) |
| `run-atoll` | The plan to create the disk, push the code, and wake it with a clock or a door, for the person to run |
| `inspect-atoll` | What it is doing, why it did something, what it waits for, and what it needs |
| `evolve-atoll` | `atoll try` against recorded history, then a push plan |

Each skill is a short list of numbered steps plus a shared `references/workflow.md` with the CLI, the
Turn API, the testing API, the rules, and the guarantees. The six copies are kept byte-identical by
`node scripts/validate-plugins.mjs` at the repository root.

## Install and use

```sh
codex plugin marketplace add /absolute/path/to/atoll
codex plugin add atoll@atoll
codex plugin list --json
```

The repository's `.agents/plugins/marketplace.json` points at this directory. Node.js 22.19 or later is
required. Start a fresh Codex chat after installing, then ask for `setup-atoll-project` or any of the
other skills by name.

Without the plugin's skills, the CLI still works from this directory:

```sh
node /absolute/path/to/atoll/plugins/codex/bin/atoll.js init ~/my-atoll
cd ~/my-atoll
npm install
npm run verify
```

## How the launcher chooses a CLI

`bin/atoll.js` runs the nearest project's installed Atoll (`node_modules/@standing-systems/atoll`), so Codex, CI, and the
person all run the version the project pins. Outside a project it runs `dist/atoll.mjs`, which the
repository's build (`npm run build`) copies into this plugin. It sets `ATOLL_HOST=codex` and
`ATOLL_LAUNCHER` (`project-pin` or `plugin-bundle`) for the CLI, and never contacts the network itself.

## What it never does

The plugin has no hooks, no MCP server, and needs no credentials. It never pushes code, creates a disk,
starts a door, or installs a clock: each of those is answered with a plan and the exact commands for a
person to run. The rules that must hold even when no skill fires are in the `AGENTS.md` that `atoll init`
writes into every project.

## Update and uninstall

To update, remove the plugin and its marketplace, then add them again, and start a fresh chat:

```sh
codex plugin remove atoll@atoll
codex plugin marketplace remove atoll
codex plugin marketplace add /absolute/path/to/atoll
codex plugin add atoll@atoll
```

To uninstall, run the first two commands only. Neither changes an existing project's pinned `atoll`.
