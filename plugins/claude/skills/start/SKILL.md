---
name: start
description: Orient someone to Atoll (standing agents that live on Archil disks), run `atoll doctor`, and point to the example systems. Use when someone asks how to get started, what atoll or this plugin does, or invokes /atoll:start. Writes no files.
allowed-tools: Bash(atoll doctor *) Bash("${CLAUDE_PLUGIN_ROOT}/bin/atoll" doctor *)
---

# Start with Atoll

Rules that hold for this whole skill:
- Write no files. Run nothing that creates a disk, pushes code, starts a door, installs a clock, or signs
  in anywhere.
- Report the doctor output as it is. Don't call the environment ready while it reports a problem.
- Never print, ask for, or repeat a credential, and never open `.env`. `atoll doctor` says whether the
  Archil API key is set, and whether it came from `.env`, without showing it.
- End with exactly one concrete next step.

## Current environment

!`"${CLAUDE_PLUGIN_ROOT}/bin/atoll" doctor || true`

## What to tell the person

1. **What an atoll is.** A standing agent is work someone hands off that stays on duty: it watches
   something, follows up, waits for days without forgetting, and asks its owner when a decision needs a
   person. In Atoll the agent is a directory on an Archil disk. Its charter, the events waiting for it, a
   journal of every turn and why it happened, what it waits for, the receipts behind its state, its
   questions for its owner, its workspace, and its code are all files on that disk. Compute is borrowed
   for each turn and thrown away, so any machine with the disk's ID and a credential can run the next
   turn, and handing the agent to another machine means passing a disk ID.
2. **What the doctor found.** Go through each problem it reports and say how to fix it. It doesn't
   contact Archil; `atoll doctor --online` also asks Archil whether it accepts the key, which the person
   can run. If the output above is missing or shows that the CLI couldn't start, say so, and suggest
   `/plugin` to check that the plugin is enabled and that Node.js 22.19 or later is on PATH.
3. **What it can always answer.** Each of these is a file, so `atoll status` prints all five and `cat`,
   `ls`, and `grep` read them too:
   - what it is trying to accomplish: `CHARTER.md`, and each part's purpose;
   - what changed, and why: `journal/`, one line per turn, naming its cause;
   - what it is waiting for: `parts/**/waiting.json` and `.atoll/next-wake`;
   - what evidence supports its state: `evidence/`, cited by hash from the journal;
   - what it needs from its owner: `asks/` and `outbox/`.
4. **Where to look.** Two example systems show the conventions end to end, and `atoll init` scaffolds
   either one as a project to read and run locally:
   - `atoll init <dir> --template release-radar` watches npm packages, keeps a ledger of the releases it
     has seen, tells its owner once per significant release, and writes a weekly digest. It uses no
     model: one http effect, with the registry's answers kept as evidence.
   - `atoll init <dir> --template promise-keeper` finds the commitments in messages through a model
     effect (a stand-in model unless a key is set), waits until each one is due, and asks before sending
     a reminder.

   Plain `atoll init <dir>` gives a one-part starter that reminds its owner of something at a set time.
5. **What to do next.** Offer one step that fits the doctor result:
   - no project yet: `/atoll:design` to shape an atoll from what the person wants kept standing;
   - a project with problems: the first fix the doctor gave;
   - a healthy project: `atoll status` to see what it is doing, or `/atoll:evolve` to change it.

The other skills: `design` (the parts table and the charter, reviewed by the part critic), `build`
(handlers and tests on a local atoll), `run` (the plan to create the disk, push the code, and wake it, for
the person to run), `inspect` (what it is doing and why), and `evolve` (try a change against recorded
history, then a push plan).

Done when: the person knows what an atoll is, what the doctor found and how to fix each problem, where
the examples are, and the one next step.
