---
name: build
description: Write or change an atoll's handlers, effects, schedules, waits, and asks in system.ts, with tests on a local atoll using @standing-systems/atoll/testing, then `atoll check`. Use when implementing an atoll design or adding behavior to an atoll, starting from the current check output. Has the effect-auditor review effects.
paths: ["system.ts", "test/**/*.ts"]
allowed-tools: Bash(atoll check *) Bash("${CLAUDE_PLUGIN_ROOT}/bin/atoll" check *)
---

# Build an atoll

Rules that hold for this whole skill:
- **Keep what already works.** Keep the existing tests as they are, and add one focused test that proves
  the requested change. Keep the files a part already writes where they are, because a running atoll has
  them on its disk.
- **Run the check and the tests before reporting.** `npm run verify` runs `atoll check`, then the tests.
  Report what they showed. If they couldn't run, say the change is unverified and give the exact command.
- **Handlers never reach outside.** No `fetch`, no `Date.now()` or argument-less `new Date()`, no
  `Math.random()`, no timers, no `process.env`, no `node:fs`, `node:net`, or `node:child_process`. All I/O
  is a declared effect requested with `t.effect(...)`, and its result comes back as an event. The time is
  `t.now`. Replay feeds handlers only the recorded inputs and the recorded clock, which is what lets the
  journal reproduce the files, and `atoll check` warns about each of these in a handler's own code.
- **Writes stay home.** A handler writes only under its own part's directory, with relative paths. It may
  read anything: a path starting with `/` is from the atoll's root, such as `/parts/ledger/releases.json`.
- **Every part is waiting for something or done.** The waits a turn declares with `t.wait(...)` replace
  the part's earlier ones; a turn that declares none keeps those its event didn't satisfy, and schedules
  re-arm by themselves until `t.done()`. `atoll check` flags a part that is neither waiting nor done.
- **The same news can arrive twice.** The runtime handles an event ID at most once within 30 days, but two
  polls can report the same release, and the person can send the same request twice, each under a new ID.
  Dedupe by the business key (the package and version, the promise) in the part's own files.
- **Effects say what they are.** Declare each one in `effects` with its kind, `approval: true` for
  anything that speaks for the person or reaches another person, `idempotent` only when a retry is safe, a
  `budget` for anything that costs or counts, and `allow` hosts for http and for anything else that reaches
  the network from a door. An effect's outcome can be in
  doubt, so a handler never treats a missing or denied result as success. An http answer is `ok` whatever
  its status, so check `result.status`, and give anything polled `pick` so the result keeps only what the
  handler reads.
- **Model output is untrusted input.** Check its shape before code acts on it. The code decides.
- Never push code, create a disk, start a door, or install a clock, and never send, tick, or answer
  against a disk. That is `/atoll:run`, a plan for the person. The local atoll is different: commands
  with `--dir .atoll-local` touch only that directory, so trying the system by hand there is fine.

## Current check

!`"${CLAUDE_PLUGIN_ROOT}/bin/atoll" check || true`

## Steps

1. Read the check output above. Fix every error before adding anything.
2. Read `CHARTER.md` and the design: the parts table from `/atoll:design`, or the person's request.
   Change the declaration in `system.ts` first: the parts and their purposes, `instances`, `schedules`,
   `effects` with their policies, and the `charter`, which holds the words of `CHARTER.md` between its
   title and `## Parts`. `atoll push` writes the disk's `CHARTER.md` from the charter and the purposes, so
   keep the project's file identical to that and keep the test that checks it.
3. Write the handlers with the Turn API. `references/turn-api.md` has the declaration, every method, and
   three complete examples.
4. For every handler that requests an effect or asks the person something, launch the `effect-auditor`
   subagent on `system.ts` and the tests. Resolve each finding with a code change or with the test it
   proposes.
5. Write the tests with `@standing-systems/atoll/testing` (`references/testing.md`): one for each behavior the person asked
   for, plus the cases its effects make possible, such as the same business event twice, an approval
   denied or left to expire, and a wait that fires once. Stub every effect a test reaches.
6. Run `npm run verify` and fix what fails. `atoll check` errors fail it; its warnings (a `fetch` or a
   `Date.now()` in a handler, a part left idle, a model effect without a budget) each need a fix or a
   reason. A custom effect's `run` isn't scanned, since outside calls belong there.
7. To watch it run by hand, use the local atoll: `atoll push --dir .atoll-local`, then
   `atoll send <to> <type> '<json>' --dir .atoll-local`, `atoll tick --dir .atoll-local`, and
   `atoll status --dir .atoll-local`. Effects really run there: http requests go out, and exec commands
   run on this machine in the atoll's `workspace/`. Try by hand only what may run for real, and leave the
   rest to tests with stubs.

Done when: `atoll check` reports no errors, the tests pass, no part is idle, and every effect is declared
with its kind, approval, idempotency, and budget. Before the code, the charter, or the reply claims a
guarantee, check it against `references/guarantees.md`.
