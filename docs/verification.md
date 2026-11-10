# Verification

What was checked for Atoll 0.1.0, how, and what it showed. Everything ran on 4 November 2026 in
California, which is 5 November in UTC, the date the records carry. The machine was a MacBook on macOS
26.6 with Node 26.13.0, against a free Archil account in `aws-us-west-2`.

The project was called stead until 9 November 2026, when it was renamed Atoll. This record gives every
command and file name under the new name, so where it says `atoll init`, what ran before the rename was
`stead init`, and a disk laid out then has `.stead/` where one laid out now has `.atoll/`.
[The rename](#the-rename) says what was rerun under the new name.

## Summary

| Check | How | Result |
| --- | --- | --- |
| Everything that needs no account | `npm run verify` | 6 of 6 gates pass (typecheck, build, tests, plugins, CLI contract, prose) |
| Unit, fault, CLI, and example tests | `npx vitest run` | 158 tests in 12 files pass |
| Crash safety | `test/runtime/crash.test.ts` | 40 crash-and-recover runs pass, plus 3 crashes around effects and answers |
| Against the live service | `npm run test:live` | 32 tests pass: the store suite (28), the door end to end (1), the door's model keys (1), and forked commands (2) |
| The release radar on a real disk, through the CLI | [the run below](#a-atoll-on-a-real-disk) | every command exits 0 |
| `atoll create` on real disks, empty and already in use | [the run below](#looking-before-laying-out) | 10 of 10 checks pass, in each of 2 runs |
| A door's model keys, on a real door | [the run below](#a-doors-model-keys) | The door's model call went out with the key it was given, and Anthropic refused that made-up key; no key reached the disk |
| The Claude Code plugin in a real session | `claude -p --plugin-dir plugins/claude` on Haiku | `/atoll:start` and an inspection question both answered from the disk, for $0.011 and $0.012 |
| Reproducible measurements | `node scripts/measure.mjs --door` | [measurements-2026-11-05.md](research/measurements-2026-11-05.md) |

## The test suites

- **`test/runtime/`** (47 tests) is the runtime itself, run against an atoll on a temporary directory.
  - `basics`: a turn's writes, messages and journal record, and the five answers. Also covers writes
    outside a part's directory refused, dead letters after three failures, `why`, and `atoll check`
    finding files changed outside a turn.
  - `crash`: the method below, and effects across a crash. An idempotent effect is retried. A
    non-idempotent one is marked in doubt and asked about, never run twice. An answer recorded just
    before a crash is applied by the next runner.
  - `semantics`: duplicates, the dedupe window, the lease, and fencing. Also waits, timers, schedules
    and their cadence, asks, approvals, budgets, large results, `pick`, the charter, and replay.
  - `hands`: exec effects scoped to the workspace, with the files they change attributed to them, and
    forked commands that merge or refuse. Also the environment a command sees: with fake Archil and
    model keys set in the runner, a command runs `env`, and no file in the atoll or its snapshots holds
    a key afterwards.
  - `models`: what reaches Anthropic's and OpenAI's APIs (the URL, headers and body, with the key only
    in its header). Also what a model effect does on a runner without its key: its stand-in answers, or,
    with none, it fails, names the key, sends nothing, and costs nothing. And which keys a runner
    somewhere else needs, and `atoll check` refusing a model name Atoll couldn't call.
- **`test/cli.test.ts`** (13) drives the built CLI as separate processes on a temporary project. It
  covers push, send, tick, status, why, asks and answers, check, replay, try, the edit hook, clock
  configuration, exit codes, and `init`. It also covers credentials read from a project's `.env`, where
  the environment wins, no value is ever printed, and a `.env` that git would commit fails `atoll
  doctor`. And it covers `create` and `push` stopping, with the top level shown, before laying an
  atoll out beside files they didn't write, and a clock that names exactly the model keys the code uses.
- **`test/store/`** (31) is one conformance suite run on the local store and, through a recorded fake of
  the SDK, on the Archil store. It covers create-only races, append races, listings (including a disk's
  top level, one level deep), and errors.
- **`test/door/`** (19): the door's HTTP server and its sandbox client. Also what `doorUp` hands
  Archil, against the SDK on a local fake: a model key travels only in one exec's env field, never in a
  command or on the disk, and a service that comes up without it takes the sandbox down. And the script
  that starts the service, run against a stand-in for Archil's services command.
- **`examples/*/test/`** (48): the release radar (20) and the promise keeper (28), against fixtures of
  real npm answers and a deterministic stand-in model.
- **`test/live/`** (32, opt-in): the store suite on a real disk, at the root and under a key prefix. Also
  the door end to end, the door's model keys, and forked commands that merge or refuse on the real
  service. Each file creates
  its own disk and deletes it, and a shared ledger refuses exec calls past a budget.

## The crash-safety method

A clean run of the scenario (an event that causes two turns) counts its mutating storage operations:
20. For every k from 1 to 20, a fresh atoll runs the same scenario with a crash injected at operation
k, in two variants: before the write lands, and after it lands but before the runner hears back.

From the crash on, the "process" is dead. The operations it starts afterwards fail, and the ones already
in flight land or not, as they would. A fresh runner then recovers, and the test checks five things:

- each event was handled exactly once;
- the part's files are what a clean run produces;
- the inbox and staging are empty;
- the journal holds one turn per event, in order;
- `atoll check` finds no file the journal didn't write.

All 40 runs pass, on each of three repetitions after the install path was made concurrent.

## An atoll on a real disk

The release radar was scaffolded with `atoll init radar --template release-radar`, installed against
the checkout, and its 20 tests passed. It then ran on a new Archil disk through the CLI. The times are
wall-clock from the laptop, network included.

| Step | Command | Time |
| --- | --- | --- |
| Check the environment, with one read-only call | `atoll doctor --online` | 0.6 s |
| Create the disk and lay out the atoll | `atoll create release-radar --disk release-radar` | 1.2 s |
| Bundle the code onto the disk, and checkpoint | `atoll push --disk release-radar` | 5.0 s |
| Start watches on rivetkit, disk, and esbuild | three `atoll send` | 1.8 s |
| Run them: 9 turns and 3 effects against the real npm registry | `atoll tick --disk release-radar` | 17.2 s |
| The five answers | `atoll status` | 2.0 s |
| Why it believes rivetkit is at 3.0.2 | `atoll why parts/watch/rivetkit/latest.json` | 0.8 s |
| The files, without a mount | `atoll ls` | 0.7 s |
| The files against the journal | `atoll check` (no errors) | 1.9 s |
| Every recorded turn through the pushed code | `atoll replay` (9 of 9 the same) | 1.5 s |
| An idle tick | `atoll tick` | 3.3 s |
| Branch the whole atoll | `atoll fork --name verify-fork` | 2.0 s |

After the install path was made concurrent and its per-tick cache added, the same disk ran a busy tick
of 6 turns and 3 effects in 10.5 s and an idle tick in 1.9 s. Records were about 0.6 s apart, against 1.1
s before. `atoll check` stayed clean and `atoll replay` reproduced 15 of 15 turns.

`atoll why` traced the version back through the turn that read npm's answer, the effect that fetched
it with its receipt, and the turn that started the watch on my command. It then said the chain was
complete.

Then the atoll was changed while it ran, as section 9 of the design describes. The example had moved on
during the build: it now asks npm for only the fields it reads (`pick`). I scaffolded the final example
and ran `atoll try --disk release-radar`. Of the disk's 15 recorded turns, 9 behaved the same and 6
differed, and the 6 were exactly the turns that request `npm.get`, now with `pick`. `atoll push` then
made the new code current (it checkpointed first), a tick ran it, `atoll check` stayed clean, and
`atoll replay` reproduced 17 of 17 turns, each through the code version that recorded it.

## Looking before laying out

Archil's own setup prompts never create folders on a disk that already has files without first showing
its top level. `atoll create` and `atoll push` now do the same, and this ran against the live service
with two new disks (`scripts/live-guard.mjs`, no exec calls):

- A brand-new disk has nothing at its root, so `atoll create` laid the atoll out without asking.
- On a disk holding `notes.txt` and `memory/keep.md`, `atoll create` exited 1, listed `memory/` and
  `notes.txt`, and wrote nothing.
- `--prefix atolls/guard` laid the atoll out under `atolls/guard/`, and `--alongside` laid it out at the
  root. Both files were byte for byte unchanged afterwards.
- Run again, `atoll create` found the atoll and didn't ask.

Both disks were then deleted. Each new test (the environment commands see, `.env`, the guard, and the
top-level listing) was also checked against its fix: with the fix undone, the test fails.

## A door's model keys

`atoll door up` now gives the door the model keys its pushed code calls its models with, and only those.
`test/live/door-models.test.ts` checked that against the live service with an atoll whose one model
effect, `summarize`, calls `anthropic/claude-haiku-5-5` and has no stand-in. The keys were made up for
the run, so no real key was used and nothing was billed.

- With no key set, `atoll door up` exited 1, named `summarize` and `ANTHROPIC_API_KEY`, and created no
  sandbox.
- With made-up Anthropic and OpenAI keys set, it handed over only `ANTHROPIC_API_KEY`, in 5.2 s.
- An event posted with the door's port token started a turn in the sandbox. Its model call reached
  `api.anthropic.com` through the Free plan's egress allowlist and came back `Anthropic returned 401:
  invalid x-api-key`. That is the made-up key, refused by Anthropic itself, so it had reached the runner
  in the sandbox.
- None of the disk's 23 objects held either key, nor did `doors.json` or anything the CLI printed. The
  door came down and the disk was deleted.

The first run of this test failed, and that changed the design. That version put the key in the
sandbox's own `env`, which Archil applies to the commands you exec there. The turn in the door answered
`ANTHROPIC_API_KEY is not set in the runner's environment`: the services a sandbox supervises don't get
that env. The key now travels in one exec's env field to a small script in the sandbox, which creates
the service with it (`archil services create --env`). That version passed. The other fix held up in the
failed run too: without its key, the door's call failed and said why, instead of answering with nothing.

The door's end-to-end test then ran again on the new way of starting the service, and passed: serving, a
pause and a 1.0 s wake, the laptop delivering while it was paused, and coming down, in 22.5 s of
sandbox time.

Each new test was also checked against its fix. With the fix undone, each of the ten fails: six for the
model path and the clock, and four for the door, including the sandbox `env` that failed live.

## The plugin in a real session

Both runs loaded the plugin for one session with `--plugin-dir`, installed nothing, used Claude Haiku
5.5, and were capped at $0.50.

- **`/atoll:start`** ran `atoll doctor` through the plugin's launcher, explained what an atoll is, said
  which settings were missing without asking for a key, and pointed at the templates: 1 turn, $0.011.
- **"What is this atoll waiting for right now, and why does it think rivetkit is at 3.0.2? Show me the
  receipt."** It used `atoll status` and `atoll why`, followed the chain from the turn to the effect,
  read the receipt and checked its hash, and said what it hadn't verified: 5 turns, $0.012.

## Archil resources used

The whole build used about 80 of the Free plan's 1,000 monthly tool calls and about 4 of its 60
sandbox-minutes:

- the research probes: 29 exec calls, 2 grep calls, 2 disks, and 38 s of sandbox time;
- building and testing the Archil store and the door: 30 exec calls, 10 disks, and about 110 s of
  sandbox time;
- these final runs: 15 exec calls, 5 disks, and one door;
- the look-before-laying-out check, run twice: 2 disks each time, both deleted, and no exec calls;
- the door's model keys: 3 disks, 3 exec calls (one checkpoint per push), and 3 doors for 48 s in all
  (two runs of the model-key test and one of the end-to-end test), plus one request to Anthropic with a
  made-up key, which it refused.

Every disk and sandbox the tests created was deleted. One disk was left on purpose: `release-radar`,
the atoll from the run above, with its branch `verify-fork`. It was laid out before the rename, under
`.stead/`, so the `atoll` CLI didn't recognise it. It was deleted on 9 November 2026, and its branch went
with it, which left the account with no disks.

## The door's network policy

Added on 9 November 2026, after the Archil account moved from the Free plan to the Developer plan. Nothing
above this section was rerun for it.

On a paid plan a sandbox created without a network policy has unrestricted egress, so a door would have
reached the open internet. `atoll door up` now asks for a policy that denies everything except the hosts
the pushed code's effects declare in `allow`, the model APIs its keys go to, and Archil's endpoints for
the disk. Each model key goes into that policy for Archil to set on the door's requests, and the service
gets a placeholder. On a plan that refuses a policy (`403 sandbox_network_plan_required`), the door comes
up as it did before.

What ran, all offline:

- `npm run verify`: 6 of 6 gates pass, with 168 tests in 12 files (158 before).
- `test/door/` (27 tests, 19 before) checks what `doorUp` hands Archil's SDK on both kinds of plan: the
  policy, the placeholder in the service's environment, the retry without a policy, and that the key
  appears nowhere but the policy. It also checks that an error from Archil that repeats a key is redacted,
  and that the service script passes on the CA Archil rewrites requests under.
- `test/runtime/models.test.ts` (10 tests, 8 before) checks that a key's route names the host and the
  headers the runner really sends it in, and which hosts a system declares.
- Each of the 15 behaviours those tests cover was undone in turn, and a test failed every time.

Then the two door tests ran against the live service, on the Developer plan in `aws-us-west-2`, and both
passed. Three things in the change came from Archil's description of network policies rather than from a
probe, and each one held:

- **The mount works under the policy.** The end-to-end test (`test/live/door.test.ts`) ran a door whose
  policy admits only `mount.*.archil.com` and `data.*.archil.com`. It served events, paused, woke in 1.0 s,
  and picked up an event delivered while it was paused, as it did on the Free plan.
- **Archil sets the key.** In `test/live/door-models.test.ts` the door came up with
  `{"egress": "declared", "allow": ["api.anthropic.com"], "brokered": ["ANTHROPIC_API_KEY"]}`. A program
  run inside the sandbox found the made-up key in no process's environment and its placeholder in one.
  It then sent Anthropic a request with no key at all and was told `invalid x-api-key`. From my laptop,
  a request with no key is told `x-api-key header is required`, and one with the made-up key is told
  `invalid x-api-key`. So the request left the sandbox without a key and reached Anthropic with one.
- **The service trusts Archil's CA.** A command in the sandbox had `NODE_EXTRA_CA_CERTS`, the service
  script passed it on, and the door's own turn came back `Anthropic returned 401: invalid x-api-key`
  rather than a certificate error.

The same program couldn't reach `example.com` or `registry.npmjs.org` from the sandbox: both connections
were reset. The npm registry is on the Free plan's allowlist, but this atoll doesn't declare it.

One thing the run showed that the documentation doesn't say: Archil's API returns a sandbox's network
policy with the key in clear text. Whoever holds the account's API key can read a door's model keys back.
That key already reaches every disk in the account, and it never goes into a sandbox.

The run used 2 disks, 2 exec calls (one checkpoint per push), and 2 doors for 18 s and 28 s. It sent
Anthropic four requests that were refused: one from the door's turn, one from inside the sandbox, and two
from my laptop. Both disks and both sandboxes were deleted, and the account was left with `release-radar`
and no sandboxes.

Last, a model answered through a key Archil holds. `test/live/door-answer.test.ts` uses the real
`ANTHROPIC_API_KEY`, so it needs a second opt-in (`ATOLL_LIVE_MODEL=1`) and `npm run test:live` never runs
it. The door came up with the key in its policy. A turn in the door asked `claude-haiku-5-5` to reply with
one word, and the answer came back `ready`, marked as the model's own and not a stand-in. Of the 5
processes in the sandbox, none had the key in its environment and one had the placeholder. None of the
disk's 25 objects held the key, nor did `doors.json` or anything the CLI printed. That run used 1 disk, 1
exec call, one door for 11 s, and one model call of at most 16 output tokens. The disk and the sandbox
were deleted, and the key left Archil's policy with the sandbox.

The Free plan's side of this, the retry without a policy, can no longer be run live from this account. It
is tested against a stand-in for Archil.

## The rename

On 9 November 2026 the project was renamed from stead to Atoll: the CLI and package, the directory an
atoll keeps its own files in (`.atoll/`, and `.atoll-local/` in a project), every `ATOLL_` environment
variable, the door's sandbox and service names, and both plugins and their skills. Archil's name alludes
to an archipelago, and an atoll is an island in one.

What ran under the new name:

- `npm run verify`: 6 of 6 gates pass, with the same 168 tests in 12 files.
- The two door tests with made-up keys, on the Developer plan: both pass. The door's sandbox was named
  `atoll-<name>-door`, its service `atoll`, and its mount `/mnt/atoll`, and the model-keys test saw what it
  saw before the rename: no process holding the key, one holding the placeholder, Archil's key on a
  request sent without one, and undeclared hosts refused. That run used 2 disks, 2 exec calls, and 2
  doors for 14 s and 24 s, and everything it created was deleted.

What didn't run again under the new name: the live store suite, the forked commands, the real-key answer
test, and the measurements. None of them names anything on the service that the door tests don't.

The name `atoll` on npm belongs to an unrelated package, so the package is `@standing-systems/atoll` and
that is what a project imports. It isn't published. `atoll init` points a new project at the checkout it
runs from, and every `npx` it writes has `--no-install`, so nothing fetches the other package by accident.

## The upgrade steward

Added on 9 November 2026 (10 November in UTC, the date its records carry). `examples/upgrade-steward` is a
third reference system: it keeps a checkout of a repository on its disk, and tries each new version of
each dependency on a branch of the whole disk. Building it added two options to `exec` effects, `merge:
false` and `ignore`, and made a runner renew its lease while an effect runs.

A probe came first, on a throwaway disk, to see whether a microVM could do the work at all. It could: it
reached GitHub and the npm registry, cloned [commander.js](https://github.com/tj/commander.js) at
v12.1.0 in 2.2 s, ran `npm ci` in 32.6 s (9,710 files), and ran the tests. A checkpoint took 171 ms and a
branch 114 ms. On the branch, installing one newer package took 5.7 s. Hashing every file under the
workspace, as the runner did around each command then, took 18.4 s for 9,957 files, which is why `ignore`
exists.

What ran offline:

- `npm run verify`: 6 of 6 gates pass, with 202 tests in 13 files (168 in 12 before).
- `examples/upgrade-steward/test/` (29 tests) replays what the steward's commands really answered on
  Archil, recorded by the live test below. One test runs both commands for real, in a shell, against a
  git repository it makes in a temporary directory: a clone, an install, a sync that skips what hasn't
  changed, trials that pass, break and can't install, and a repository that isn't there. Three more run
  the request to GitHub against a local stand-in for its API.
- `test/runtime/hands.test.ts` (10 tests, 6 before) covers ignored directories and commands that are
  never merged, and `test/runtime/semantics.test.ts` has one more, for the lease.
- Each of 19 behaviours those tests cover was undone in turn, and a test failed every time.
- A project scaffolded with `atoll init --template upgrade-steward` installed, typechecked, passed its
  29 tests, and passed `atoll check`.

What ran against the live service, on the Developer plan in `aws-us-west-2`: `test/live/steward.test.ts`,
twice, and `test/live/fork.test.ts` once more, since the forked-command code changed. All passed. The
steward's test keeps commander.js at v12.1.0, with npm stubbed to name two versions and the registry,
git and the tests all real:

| | First run, 03:04 UTC | Second run, 03:25 UTC |
| --- | --- | --- |
| The first tick: clone, install, tests, 15 watches, two trials | 179 s | 233 s |
| The repository's own tests at head | 32 s | 47 s |
| typescript 7.0.2 on a branch: install, then tests (one suite fails) | 5 s, 22 s | 6 s, 46 s |
| prettier 3.9.10 on a branch: install, then tests (all pass) | 2 s, 27 s | 2 s, 36 s |
| prettier 99.99.99 on a branch (npm has no such version), whole tick | 9.8 s | 10.6 s |
| A second sync with nothing new upstream, whole tick | 9.0 s | 9.7 s |

The test also read the branches afterwards through the object API. The typescript branch had typescript
7.0.2 installed, the prettier branch had prettier 3.9.10 and typescript 5.4.5, and the main disk still had
5.4.5 and 3.2.5, with its `package.json` unchanged. Only the passing trial raised an approval, and
approving it with no `GITHUB_TOKEN` sent nothing. Separately, `atoll cat --disk <branch id>` read a
branch's file from the CLI.

All of it used 6 disks and 37 exec calls, and every disk was deleted.

## What wasn't verified

- **Months of standing operation.** The longest runs here are a simulated week in the tests and minutes
  on the live service.
- **The door as a permanent host.** The Free plan caps a sandbox session at 30 minutes and allows an hour
  of sandbox time a month, so the door was tested for minutes.
- **Real model calls from a laptop or CI runner.** Model effects ran on their stand-ins, and the promise
  keeper's model was never called. On 4 November the one request that reached a provider, from the door,
  carried a made-up key and was refused. Since then one model has answered Atoll, through a door
  ([the section above](#the-doors-network-policy)), and none from any other runner.
- **The Codex plugin in a live Codex session.** Its manifest validates against the Agent Plugins schema
  and its launcher runs the CLI, but it wasn't loaded into Codex.
- **Plugin evaluations** (`claude plugin eval`) comparing sessions with and without the plugin. actord's
  cost about $16 a run; none were run here.
- **Credentials from `.env` against the live service.** The live runs took them from the environment;
  reading `.env` is covered by the CLI tests. I didn't copy the real key into a new file to test it.
- **Mounting an atoll's disk on my own machine.** The Free plan doesn't allow external mounts, which is
  why `atoll ls` and `atoll cat` exist.
- **A pull request the steward asked for.** Its request to GitHub is tested against a local stand-in.
  No `repository_dispatch` event has been sent to a real repository, and `github/atoll-upgrade.yml` has
  never run.
- **The steward on a clock, or on a repository of mine.** It ran for minutes, against one public
  repository, with npm's answers pinned. It can't clone a private repository.
- **A command that outlasts the lease.** The runner renews its lease while an effect runs, and a test
  shows the renewals. On the live service the longest command took 47 s against a 60 s lease, so the
  renewals happened but were never what kept the lease.
- **A door without a network policy, since the change.** The Free plan's path is tested only against a
  stand-in for Archil ([the section above](#the-doors-network-policy)).
