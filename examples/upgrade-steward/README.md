# Upgrade steward

Upgrade steward keeps one of my repositories on its disk: a checkout, with the dependencies installed.
It watches every npm package the repository depends on. When one publishes a version newer than the
repository has, it tries that version on a branch of the whole disk: installs it, runs the tests, and
tells me what happened. If the tests pass, it asks whether to open a pull request, and asks GitHub for
one only when I say yes. It uses no model, so every decision it makes can be replayed exactly.

| Part | Instances | What it keeps | What it waits for |
| --- | --- | --- | --- |
| `repo` | One | `repo.json` (the repository, the commit its checkout is at, and how its own tests did there), `deps.json` (each direct dependency and the version installed), `health.json` (only while syncs fail) | Its six-hourly sync, and each sync's result |
| `watch` | One per dependency, such as `watch/typescript` or `watch/types__node` | `watch.json` (the dependency as the repository has it), `latest.json` (the version npm last called latest, and the trial it went to), `health.json` (only while checks fail) | Its six-hourly check, and npm's answer |
| `trial` | One per package and version, such as `trial/typescript-7.0.2` | `trial.json` (the verdict, the commit, the branch, the timings, and what happened about a pull request), `output.txt` (the end of the run) | The trial's result, then my answer about a pull request |

The checkout itself is in `workspace/repo/`, which is where commands run. Parts never write there.

## How it decides

**What is worth a trial.** A stable version newer than the one installed in the checkout. A prerelease
is never tried, and neither is a version the repository already has or has passed. The comparison is
with what the repository has, not with the last version seen, so a patch that follows a minor release
it hasn't adopted is still a minor move.

**One trial per version.** The trial's instance is named for the package and version, so a second
report of `typescript 7.0.2` finds `trial/typescript-7.0.2` already there and changes nothing. To run
one again, I send it `trial.retry` with `{"again": true}`.

**The repository's own tests come first.** A trial means something only if the tests pass without the
upgrade. Every sync that finds a new commit, or a changed `package.json` or lockfile, runs them and
records the result against that commit. While they fail, every trial is held, and I'm told once. When a
later commit passes, the held trials run.

**A verdict has three outcomes, and they are told apart.** The tests pass with the new version. They
fail with it, having passed without it. Or it couldn't be installed at all, so the tests never ran.
Each notice carries the last lines of the output, and the evidence keeps all of it. A command that
never reports, because the microVM timed out, is a fourth thing: not a verdict, and it can be retried.

**A pull request needs my approval of that exact upgrade.** `pr.open` is declared with `approval:
true`, so the runner asks me with its arguments in front of me: the repository, the package, both
versions, the commit the tests passed at, and the branch that holds the result. An approval I don't
answer in three days counts as no. Nothing is asked of GitHub before that.

## What Archil does here

This is the part a laptop and a CI job don't do well, and the reason the example exists.

**The checkout stays installed, and a branch of it is nearly free.** The first sync of
[commander.js](https://github.com/tj/commander.js) at v12.1.0 cloned the repository in 2 s and ran
`npm ci` in 33 s, leaving 9,710 files in `node_modules`. After that, every trial starts from a
copy-on-write branch of the whole disk, which took 114 ms to make. On the branch, installing one new
version took 2 to 6 s, because everything else was already there. A CI job would spend the 33 s every
time.

**The commands run beside the files.** Each sync and each trial is one command in a fresh microVM with
the disk mounted. The microVM holds no credential of mine: its environment carries the disk's ID and
region and nothing else. It reached GitHub and the npm registry. The full test suite, 1,104 tests in
102 suites plus the type checks, took between 22 and 47 s there, across two runs.

**A trial leaves its checkout behind.** `trial.run` is declared with `fork: true, merge: false`: the
command runs on a branch, and nothing is copied back. The verdict comes back in the command's output,
and the branch keeps the tree that produced it. When typescript 7.0.2 broke one suite, the checkout that
broke was still there to look at:

```bash
atoll cat workspace/repo/package.json --disk dsk-0000000000111dc9
atoll cat workspace/.steward/test.log --disk dsk-0000000000111dc9
```

The main checkout was never touched. After three trials it still had typescript 5.4.5 and prettier
3.2.5 installed, and its `package.json` still asked for `^3.2.5`.

**The runner doesn't walk what nobody reads.** Both commands are declared with `ignore:
["node_modules", ".git", ".steward"]`. Without it, the runner hashes every file under the workspace
before and after each command to work out what changed, and for this checkout that took 18 s each way.

These were measured on 10 November 2026 in `aws-us-west-2`, by two runs of `test/live/steward.test.ts`
in the Atoll repository and the probe before them.

## Run it

The steward needs an Archil disk, because a trial is a branch of one. A local atoll can sync a
repository, but it has nothing to branch. The tests run without either:

```bash
npm test
```

In the Atoll repository itself, run `npm test -- examples/upgrade-steward` from the root. The fixtures in
`test/fixtures/` are what the steward's commands really answered on Archil, and one test runs both
commands in a shell against a small repository it makes in a temporary directory, so it needs `git` and
`npm` on the machine.

On Archil, with `ARCHIL_API_KEY` and `ARCHIL_REGION` set in your environment or in this project's
`.env`, from this directory:

```bash
atoll create upgrade-steward --disk upgrade-steward
atoll push --disk upgrade-steward
atoll send --disk upgrade-steward repo repo.track '{"url": "https://github.com/tj/commander.js"}' --tick
atoll status --disk upgrade-steward
```

`repo.track` takes the URL of a public repository on GitHub, and optionally `"ref"` (a branch or tag to
follow instead of the default branch) and `"test"` (the command that runs the tests, `npm test` unless
you say otherwise). The first tick clones, installs, runs the tests, starts a watch for each
dependency, and tries whatever is already newer than the repository has. For commander.js, with two
versions to try, that took three to four minutes.

Then, as things come up:

```bash
atoll asks --disk upgrade-steward
atoll answer --disk upgrade-steward <ask-id> approve
atoll send --disk upgrade-steward trial/typescript-7.0.2 trial.retry '{"again": true}' --tick
```

Archil has no timers, so something outside has to call `atoll tick`:

```bash
atoll clock --disk upgrade-steward --crontab
atoll clock --disk upgrade-steward --github
```

Run the clock from your machine or from CI, not from a door. A door's sandbox reaches the disk through
a mount and has no way to branch it, so a trial started there fails and says so.

## The pull request

The steward doesn't push to my repository, and the microVMs couldn't if they tried. When I approve,
`pr.open` sends the repository one `repository_dispatch` event named `atoll-upgrade`, with the package,
the version, and where the trial's evidence is. A workflow in the repository answers it: it runs the
same `npm install`, pushes the change to a branch, and opens the pull request with the repository's own
token. That workflow is `github/atoll-upgrade.yml` here; copy it to `.github/workflows/` in the
repository.

The event is sent from whichever machine runs `atoll tick`, with the token in `GITHUB_TOKEN` there. It
needs write access to the repository's contents, which is what GitHub asks for to send that event.
Without a token nothing is sent: the steward tells me it couldn't ask, and gives me the `npm install`
line to run myself.

GitHub answers the event with an empty 204, so the steward knows the request was taken, not that the
pull request exists. It says "I asked GitHub", not "I opened".

Two things the workflow needs from the repository. Its organization, or the repository itself, has to
allow GitHub Actions to create pull requests (Settings, Actions, General). And it should run the Node
whose npm wrote the lockfile: the first pull requests I got were made by an older npm, which rewrote
35 lines of the lockfile that had nothing to do with a one-line upgrade.

## On GitHub Actions

The Atoll repository is kept by a steward of its own, and nothing of it runs on my machine. Three
workflows in its `.github/workflows/` do everything:

- `atoll-tick.yml` is the clock. Twice an hour it builds the CLI and runs `atoll tick`, then writes
  `atoll status` and the open questions to the run's summary. It gives the tick its own token, which is
  enough to send the `repository_dispatch` event, and that event does start another workflow.
- `atoll-answer.yml` answers a question from the Actions tab: I give it the question's ID and choose
  approve or deny.
- `atoll-upgrade.yml` is the workflow above, with one step added to rebuild the CLI that Atoll bundles
  into its tree.

The repository's secrets hold `ARCHIL_API_KEY`, and that is the only credential involved. The first tick
took 2 minutes 28 seconds. It cloned the repository, installed it, and ran its type check, build and 202
tests in 20 s. It started six watches, found three dependencies behind, and tried each on a branch: the
`disk` SDK 1.12.0, `@types/node` 26.6.6, and `vitest` 5.1.0, about 20 s of tests each. All three passed. I
approved all three from the Actions tab, and three pull requests opened.

## What it costs

On Archil, a sync is one tool call and a trial is two (a checkpoint, then the command). Watching fifteen
dependencies costs none: the requests to npm come from the machine that runs `atoll tick`. The budgets
in `system.ts` allow 400 syncs and 300 trials a month, which is at most 1,000 tool calls: the Free
plan's whole allowance, or five cents at the paid rate of $0.05 per 1,000.

The checkout with its dependencies is about 130 MiB for commander.js, a few cents a month at $0.20 per
GiB-month. A branch stores only what its trial changed.

Branches and checkpoints can't be deleted on Archil yet, so every trial's branch lasts as long as the
disk does. `atoll status` counts them.

## What it doesn't do

- **Private repositories.** The command that clones holds no credential, by design. To keep a private
  repository, put its tree in `workspace/repo/` yourself, through a mount or the disk's S3 API.
- **Anything but npm, and one package at a time.** It doesn't group upgrades, and it reads only
  `dependencies`, `devDependencies` and `optionalDependencies` of the top-level `package.json`.
- **Long test suites.** A command has five minutes in a microVM. A sync that installs and tests, or a
  trial, has to fit in that.
- **Merging.** It opens one pull request per upgrade and stops. Two that touch the same lockfile will
  conflict once the first is merged.
