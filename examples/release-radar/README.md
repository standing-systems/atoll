# Release radar

Release radar watches npm packages for me. Every hour it asks the registry for each package's latest
version. It keeps a ledger with one file per release it has seen, and tells me once when a package
moves to a new major or minor version. Patches go into the ledger without a notice. Every Monday at
16:00 UTC it writes a digest of the week's releases and sends me that too. It uses no model, so every
decision it makes can be replayed exactly.

| Part | Instances | What it keeps | What it waits for |
| --- | --- | --- | --- |
| `watch` | One per package, such as `watch/rivetkit` | `watch.json` (the package), `latest.json` (the version npm last called latest, with its receipt), `health.json` (only while checks fail) | Its hourly schedule, and npm's answer after each check |
| `ledger` | One | `releases/<name>@<version>.json`, one per release, and `latest.json`, the newest stable version recorded for each package | The next `release.seen` from a watch |
| `digest` | One | `digests/<date>.md`, and `last.json`, where the last digest ended | Mondays at 16:00 UTC |

## How it decides

The first version a watch reads is a baseline. The ledger records it and tells me nothing, because
where a package stands when I start watching it isn't news. When the tests start, rivetkit is at
2.3.30, a release three weeks old.

Every later release is compared with the newest stable version the ledger has recorded for that
package, not judged by its own number. A new major or minor version is significant. A patch, a
prerelease, or a version no newer than the recorded one is not. The comparison matters because a check
sees only the version npm calls latest at that moment, so when nothing ticks for a while, say because
the laptop running the clock was asleep, several releases can land between two checks. In the tests,
rivetkit publishes 3.0.0 and then 3.0.1 while nothing ticks. Judged by its own number, 3.0.1 is a
patch. Compared with 2.3.31, the last version recorded, it is the major release it really is.

The ledger's business key is the package and version. A second report of `rivetkit@3.0.0`, from a
redelivered event or a second watch on the same package, finds the file already there and changes
nothing, so nothing is told or counted twice.

A failed check, such as an HTTP 500, a timeout, or an answer without a version, is written to the
watch's `health.json`, and what the watch knows stays as it was. One failure is usually the network,
so the watch tells me only after three in a row, and once more when it can read npm again.

The digest reads the ledger's files directly instead of messaging it. Each digest lists what the
ledger recorded since the one before it, so every release appears in exactly one digest, even one
reported late.

The watch fetches `https://registry.npmjs.org/<name>/latest` rather than the package's whole document,
which for rivetkit is 5.2 MB. Its request picks the two fields it reads, the name and the version, so
the result recorded in the journal is a few dozen bytes. The evidence keeps npm's whole answer, 7.5 KB
for rivetkit, and since that answer stays byte for byte the same until the next release, each one is
stored once.

## Run it locally

From this directory, with the Atoll CLI installed:

```bash
atoll push --dir .atoll-local
atoll send --dir .atoll-local watch/rivetkit watch.start '{"package": "rivetkit"}'
atoll send --dir .atoll-local watch/disk watch.start '{"package": "disk"}'
atoll tick --dir .atoll-local
atoll status --dir .atoll-local
```

`.atoll-local/` is a project's default local atoll, and it is gitignored, so `--dir` is optional
here. The first tick takes each package's baseline. Each watch is an instance named by you. A scoped
package needs a plain instance name: `atoll send watch/types-node watch.start '{"package": "@types/node"}'`.

Nothing happens between ticks. Tick again an hour later and each watch checks npm; tick on a Monday
after 16:00 UTC and the digest is written. Notices land in `notices/<date>/`, and every question
`atoll status` answers can also be answered with `ls` and `cat`:
`cat .atoll-local/parts/watch/rivetkit/latest.json`. On a disk you can't mount, `atoll ls` and
`atoll cat` do the same.

The tests run without the network:

```bash
npm test
```

In the Atoll repository itself, run `npm test -- examples/release-radar` from the root. The fixtures in
`test/fixtures/` are npm's real replies for rivetkit and disk, fetched on 5 November 2026 and trimmed
to the fields used. The tests replay the real release history from those replies, so every version
and date in them really happened.

## Run it on Archil

You need an Archil account, with `ARCHIL_API_KEY` and `ARCHIL_REGION` set in your environment or in
this project's `.env`, which its `.gitignore` already ignores.
`atoll doctor` checks both without printing either. Then, from this directory:

```bash
atoll create release-radar --disk release-radar
atoll push --disk release-radar
atoll send --disk release-radar watch/rivetkit watch.start '{"package": "rivetkit"}'
atoll send --disk release-radar watch/disk watch.start '{"package": "disk"}' --tick
atoll status --disk release-radar
```

`atoll create` makes the disk and lays out an empty atoll. `atoll push` bundles `system.ts`, stores
it on the disk, makes it the current code, and takes a checkpoint. Add `"atoll": {"disk":
"release-radar"}` to the project's `package.json` and you can drop `--disk` from every command.

Archil has no timers, so something outside has to call `atoll tick`. The default clock ticks every
15 minutes, so a check or the digest is never more than 15 minutes late. Don't slow it to exactly
hourly: a schedule re-arms an hour after the turn that fired it, so an hourly clock can miss it by
moments and check only every two hours. Both of these print the configuration rather than install it:

```bash
atoll clock --disk release-radar --crontab
atoll clock --disk release-radar --github
```

The first is a crontab line for this machine. The second is a GitHub Actions workflow that ticks with
your API key as a repository secret.

## What it costs on the Free plan

Nothing. Archil's Free plan includes five disks of up to 10 GB each, 1,000 tool calls, and one
sandbox-hour a month. Release radar uses one disk. Its turns read and write files through the object
API, which isn't a tool call, and its requests to npm come from whichever machine runs `atoll tick`.
The only tool call is the checkpoint `atoll push` takes, one per push (`--no-checkpoint` skips it). It
needs no door, since nothing calls it but the clock. If you run one anyway, it can reach the npm
registry: `npm.get` declares it, and it is on the Free plan's sandbox allowlist.

Watching rivetkit and disk hourly for two weeks, over their real releases of 26 October to 9 November
2026, took 1,358 turns and 674 requests to npm, and left 2.1 MB on the disk: about 1 MB a week for the
two packages. Nine tenths of it is the journal, about 2.6 KB per check. The evidence is 47 KB, npm's
eight distinct answers for eight releases, each stored once. At that rate the disk would take more
than a century to reach the 10 GB limit, and on a paid plan a year of it would cost about a cent a
month at $0.20 per GiB-month.

A crontab clock costs nothing. A GitHub Actions clock spends Actions minutes, not Archil's allowance.
