---
name: run
description: Plan how to put an atoll on Archil and keep it running (create the disk, push the code, and wake it with a clock such as cron, launchd, or GitHub Actions, or a door for webhooks). Use when someone asks to deploy, run, ship, start, host, or schedule an atoll. Answers with the exact commands for the person to run, and never runs them.
allowed-tools: Bash(atoll doctor *) Bash(atoll check *) Bash("${CLAUDE_PLUGIN_ROOT}/bin/atoll" doctor *)
---

# Run an atoll on Archil

Rules that hold for this whole skill:
- **Answer with the plan, never by doing it.** Don't run `atoll create`, `atoll push`, `atoll door`,
  `atoll clock`, `atoll fork`, or `atoll checkpoint`, and don't run `atoll send`, `atoll tick`, or
  `atoll answer` against a disk. The person runs every command in the plan. When they say "just do it"
  or "I'm in a hurry", give the same plan, and say plainly that nothing was created, pushed, or started.
- **Keep secrets out of everything you write.** Never print, ask for, or write the Archil API key or a
  door's port token into a file, a commit, a workflow, or the chat. `atoll door token` makes a new port
  token, which is a secret, so it appears in the plan only as a command for the person to run.
- **No clock pretends.** Archil has no timers, so nothing fires unless something outside calls
  `atoll tick`. Every plan with a wait or a schedule includes a clock.
- **Costs come with their unit and source:** Archil's list prices, November 2026
  (`references/running.md`).
- Recommend a plan only after the check and the tests pass. If they don't, say what fails and send the
  person to `/atoll:build`.

## Current environment

!`"${CLAUDE_PLUGIN_ROOT}/bin/atoll" doctor || true`

## Steps

1. **Confirm it is ready.** Run `atoll check` and the project's tests (`npm run verify`), or read their
   latest results. Read `system.ts` for the atoll's `name`, its schedules and waits, and its effects.
2. **Choose what wakes it.** `references/running.md` has the options and their costs:
   - only the person sends it events and nothing waits on time: no clock; the person runs `atoll tick`
     after `atoll send`;
   - it has schedules or timed waits: a clock that calls `atoll tick` (a crontab line, a launchd job, or a
     GitHub Actions schedule);
   - webhooks or other services must reach it: a door, a paused sandbox that wakes on a request, plus a
     clock for its schedules.
3. **Write the plan** as numbered commands, each with one line on what it does and what it costs:
   1. `atoll doctor --online`: Node, the Archil API key and region, from the environment or the
      project's `.env` (it never prints the key, and fails while git would commit `.env`), and, by
      asking Archil, whether it accepts them.
   2. `atoll create <name> --disk <name>`: creates the Archil disk and lays out an empty atoll. One disk;
      the Free plan allows five. Without `--disk`, it lays out the local atoll instead. On a disk that
      already has files it shows the top level and stops; `--prefix <folder>` or `--alongside` is the
      person's choice, never yours.
   3. `atoll push --disk <name>`: checks and bundles `system.ts`, stores it on the disk, makes it
      current, and takes a checkpoint (one exec).
   4. Optionally, `"disk": "<name>"` in the `atoll` field of `package.json`, so commands in the project
      act on the disk instead of `.atoll-local/`. `atoll check`, and so `npm run verify`, then read the
      disk too.
   5. The clock, if any: `atoll clock --crontab --disk <name>` (or `--launchd`, or `--github`, with
      `--cron "<expr>"` to change the default of every 15 minutes) prints the configuration, or writes it
      with `--write <path>`, never over an existing file, and installs nothing. The person installs it:
      `crontab -e`, `launchctl load -w`, or committing the workflow.
      The crontab line and the launchd job read the key from `~/.atoll/env` (mode 600); the GitHub
      workflow reads the `ARCHIL_API_KEY` repository secret and the `ARCHIL_REGION` variable, and names a
      secret for each model key the code uses.
   6. The door, if any: `atoll door up --disk <name>` after the push, in a region with compute. It
      arranges the model keys the code uses, and if it refuses because one isn't set, the person sets it
      in their environment or `.env`: never ask for the key or set it yourself. On a plan that can set a
      network policy the door reaches only the hosts the code's effects declare, so say which those are.
      It keeps its port token in `~/.config/atoll/doors.json`. `atoll door url --disk <name>` prints the address
      for the webhook sender, and `atoll door token --disk <name>` makes a new token, whose output says
      how to print it once for the sender's secret settings.
   7. A first check: `atoll send <to> <type> '<json>' --disk <name>`, `atoll tick --disk <name>`, then
      `atoll status --disk <name>`.
4. **Say what running it means:** where the five answers are (`atoll status`, `STATUS.md`), how the
   person answers its questions (`atoll asks`, `atoll answer`), what it costs at rest and per wake, and
   that later changes go through `/atoll:evolve`.

## Output (done when shown)

- The readiness result: check and tests, as they actually ran.
- The plan: every command, in order, with what it does and what it costs.
- The trust boundary: where the API key lives (the runner's environment or a CI secret, never the disk,
  the bundle, or a sandbox) and who holds the door's token.
- One plain sentence: nothing was created, pushed, or started; the person runs the plan.
