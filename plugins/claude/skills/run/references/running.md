# Where turns run, what wakes them, and what it costs

## Runners

A runner is any process that holds the disk's ID and a credential and calls `atoll tick`. A tick acquires
the lease, recovers anything a previous runner left half done, delivers due timers, handles the inbox
until it is empty or the tick's turn limit is reached, runs effects, rewrites `STATUS.md`, optionally
takes a checkpoint, and releases the lease. A runner holds nothing between ticks, so a laptop, a CI job,
and a sandbox are interchangeable runners of the same atoll. One runner at a time holds the lease; a
second one that starts while it is held finds the atoll busy and leaves.

## What wakes it

Archil has no triggers, timers, or change feeds. The only inbound wake is network traffic to a sandbox.
So an atoll is woken from outside, in one of these ways:

| Way | What it is | When to use it | Cost |
| --- | --- | --- | --- |
| The person | `atoll send <to> <type> [json]`, then `atoll tick` | Nothing waits on time, and no outside service sends it events | None |
| A crontab line or launchd job | `atoll clock --crontab` or `--launchd` prints one that runs `atoll tick` from the project, reading the key and region from `~/.atoll/env` (mode 600) | A machine that is usually on runs it | None |
| GitHub Actions | `atoll clock --github` prints a scheduled workflow for `.github/workflows/atoll-tick.yml` that runs `atoll tick`, with `ARCHIL_API_KEY` as a repository secret and `ARCHIL_REGION` as a repository variable, plus a secret for each model key the code uses, which it names | No machine is always on | GitHub Actions minutes, not Archil |
| The door | `atoll door up`: a small sandbox (1 vCPU, 1 GiB) running `atoll serve` from the disk; `POST /events`, `POST /tick`, `GET /status`, behind an Archil port token that also wakes it | Webhooks or other services must reach it | Sandbox time while awake, nothing while paused |

`atoll clock` prints a configuration that ticks every 15 minutes unless `--cron "<expr>"` says
otherwise, or writes it with `--write <path>`, never over an existing file. It installs nothing;
installing it is the person's step. `atoll clock --door` prints a scheduler line that asks the door to
tick instead. A timer fires at the first tick after it is due, so
the clock's interval is the precision of every wait. Every tick writes `.atoll/next-wake`, and
`atoll status` says when the next wait is due.

## The door, in detail

The door mounts the disk in conditional mode, so the object API keeps working for every other client. It
holds no state of its own and can be deleted and recreated at any time. It needs no Archil API key,
because it reaches the disk through its mount. `atoll door up` works out the model keys the pushed code
calls its models with, takes them from the person's environment or `.env`, and uses no others. It refuses
when a model effect with no stand-in would have no key, and it says which effects will answer with their
stand-ins. A paused door answers its first request in about 0.7 seconds (measured 5 November 2026,
`aws-us-west-2`).

What the door may reach depends on the Archil plan, and `atoll door up` says which case applies:

- **A plan that can set a sandbox's network policy (Developer and above).** The door reaches the hosts
  its effects declare in `allow`, the model APIs its keys go to, and nothing else outside Archil. Archil
  adds each model key to the door's requests to that provider, and the door holds a placeholder, so no
  code in the sandbox can read the key. An effect of any kind that reaches the network from a door has to
  list its hosts in `allow`, a custom or exec effect included.
- **The Free plan.** The door reaches only Archil's managed allowlist of registries, Git hosts, and model
  APIs (the npm registry is on it), and its service holds the model keys.

A door brought up before the plan changed keeps what it had. Take it down and bring it up again.

`atoll door up` needs code pushed to the disk first, and a region with compute: exec, sandboxes, and
doors run in `aws-us-east-1`, `aws-us-west-2`, and `aws-eu-west-1`, and other regions are storage only.
The door's port token is kept in `~/.config/atoll/doors.json` on the machine that brought it up.
`atoll door token` makes a new one there, for a webhook sender's or a scheduler's secret settings.

## Trust and secrets

| Component | Trusted | Holds | Reaches |
| --- | --- | --- | --- |
| A runner (`atoll tick`) on the person's machine or CI | Yes | The Archil API key; model keys if configured | The disk, and the hosts its effects declare |
| The door | Yes | On a plan with network policies, placeholders for the model keys Archil adds to its requests; on the Free plan, the model keys its code uses. The disk arrives as a mount | The disk and the hosts its effects declare; on the Free plan, Archil's egress allowlist instead |
| Handlers (`system.ts`) | The person's code | Nothing | Only the Turn API |
| Hands (`exec` effects) | No | Nothing | A mount of one subdirectory |

The API key never goes into a sandbox, a bundle, the disk, or the journal. An Archil API key reaches every
disk in the account, so untrusted commands are scoped by mount rather than by credential. A key works
only in the region it was created in; `atoll doctor --online` asks Archil whether it accepts it.

## Costs

Archil's list prices, November 2026:

- **An atoll at rest:** its files at $0.20 per GiB-month. A release watcher's disk is under 1 MiB after a
  week, well under a cent a month.
- **A turn:** no tool calls. The control plane is Archil's object API, which isn't billed as compute.
- **A push:** one exec, for the checkpoint.
- **Hands:** $0.05 per 1,000 exec calls. A forked command is two calls.
- **The door:** $0.055 per vCPU-hour plus $0.020 per GiB-hour while awake, nothing while paused. A door
  woken 100 times a day for about 20 seconds each is awake about 17 hours a month: about $1.25 at 1 vCPU
  and 1 GiB.
- **The clock:** a crontab line costs nothing; a GitHub Actions schedule costs Actions minutes.

The Free plan (1,000 tool calls and one sandbox-hour a month, five disks) runs an atoll whose turns cost no
tool calls from a laptop or CI indefinitely. It can run a door for a demo, but not as a standing host;
that needs the Developer plan.

## After it is running

- `atoll status --disk <name>` gives the five answers; `STATUS.md` on the disk has them in prose after
  every tick.
- `atoll asks` lists the questions waiting for the person, and `atoll answer <ask-id> <option>` answers
  one. An answer can also be written by hand as `asks/<id>.answer.json`.
- `atoll checkpoint <name>` snapshots the whole disk between ticks, and `atoll fork --checkpoint <name>`
  makes a full copy to inspect or try things on. Archil can't delete checkpoints or branches yet, and
  `atoll status` counts the ones Atoll created.
- Changing the code is `/atoll:evolve`: `atoll try` against the recorded history, then a push plan.
