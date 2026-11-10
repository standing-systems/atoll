# upgrade-steward

I maintain a repository, and the packages it depends on move faster than I can check them.

Keep a checkout of the repository I name on your disk, with its dependencies installed, and bring it up
to date every six hours. Watch every package it depends on. When one publishes a version newer than the
one the repository has, try it: on a copy of the whole checkout, install that version and run the tests.
Tell me what happened, with the output, and keep the copy so I can look at it.

If the tests pass, ask me whether to open a pull request, and ask GitHub for it only when I say yes. If
they fail, tell me and stop there.

A trial means something only if the repository's own tests pass without the upgrade. Run them whenever
the checkout changes. While they fail, hold every trial, and tell me once.

## Never

- Never change the repository. A trial happens on a copy, and a pull request is the repository's own
  workflow making the change after I approve it.
- Never open a pull request, or ask for one, without my approval of that exact upgrade.
- Never blame an upgrade for tests that were already failing.
- Never try the same version of a package twice unless I ask.
- Never try a prerelease.
- Never ask npm more than 10,000 times in a month, sync more than 400 times, or run more than 300
  trials.
- Never change which repository you keep, or your own code, without me.

## Parts

- **repo**: Keep a checkout of my repository up to date, with its dependencies installed and its own tests run.
- **watch**: Send each new version of this dependency to a trial.
- **trial**: Try one new version of one dependency on a copy of the checkout, and tell me whether the tests still pass.
