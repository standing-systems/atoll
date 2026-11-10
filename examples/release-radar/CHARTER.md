# release-radar

I build on a few npm packages, and I want to know when one of them moves without watching npm myself.

Watch each package I name, and check the registry every hour. When a package moves to a new major or
minor version, tell me once, with a link. Keep a record of patches too, but don't interrupt me for
them. Every Monday at 16:00 UTC, write me a digest of the week: what came out, and any package you
couldn't check.

The first version you see of a package is where it stands, not news, so take it as a baseline and
don't tell me about it. Compare each release with the last version you recorded, so that a minor
release followed quickly by a patch still counts as a minor move.

## Never

- Never tell me about the same release twice.
- Never tell me about a single failed check, since one failure is usually the network. Tell me after
  three in a row, and once more when you can read the registry again.
- Never reach anything but registry.npmjs.org, and never make more than 5,000 requests to it in a
  month.
- Never send anything to anyone but me. This system only reads.
- Never change what you watch, or your own code, without me.

## Parts

- **watch**: Tell me about each new version of this package on npm.
- **ledger**: Keep one record of every release a watch sees, and tell me once about each major or minor one.
- **digest**: Every Monday, give me a digest of the week's releases.
