# Archil measurements, 2026-11-05

Measured by `scripts/measure.mjs` on 2026-11-05T05:15:28Z from darwin 25.6.0,
against a fresh disk in `aws-us-west-2` that the script deleted afterwards. Node v26.13.0, `disk` SDK 1.11.0.
Times are milliseconds on the client, network included, unless marked server-side. Every sample is in the
percentiles; failures are counted, and listed at the end.

## Object API (sequential)

| Operation | n | ok | failed | p50 | p90 | min | max | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| first request on a new connection (HEAD, missing key) | 1 | 1 | 0 | 498.4 | 498.4 | 498.4 | 498.4 | TLS and HTTP/2 setup |
| put (1 KiB) | 20 | 20 | 0 | 57.9 | 116.2 | 56.0 | 173.9 |  |
| get (1 KiB) | 20 | 20 | 0 | 51.9 | 54.8 | 48.8 | 139.1 |  |
| head | 20 | 20 | 0 | 53.4 | 61.4 | 45.8 | 106.5 |  |
| head, missing key | 20 | 20 | 0 | 50.7 | 104.9 | 47.3 | 122.6 |  |
| list (20 keys, recursive) | 20 | 20 | 0 | 53.5 | 64.1 | 50.9 | 139.2 |  |
| append (120 B, existing key) | 20 | 20 | 0 | 53.8 | 58.4 | 49.1 | 119.9 |  |
| create-only put, uncontended | 20 | 20 | 0 | 58.4 | 94.2 | 53.8 | 126.0 |  |
| delete | 20 | 20 | 0 | 53.2 | 56.8 | 51.2 | 141.4 |  |

## Races (concurrent)

| Race | Rounds | Result |
| --- | ---: | --- |
| create-only PUT (`If-None-Match: *`), 10 writers on one new key | 3 | winners per round: 1, 1, 1; 412s: 9, 9, 9; errors: 0; final body is the winner's: yes; wall 102.1, 71.0, 65.9 ms |
| append, 20 writers on an existing key | 1 | 20/20 landed whole; 0 duplicated; 0 torn or interleaved; 0 errors; wall 78.9 ms |
| append, 20 first writers on a missing key, raw SDK (no retry) | 1 | 9/20 succeeded and 9 landed; 11 got 409 OperationAborted ("created by another writer"), and those wrote nothing; 0 duplicated; 0 torn; wall 171.3 ms |
| append, 20 first writers on a missing key, ArchilStore (retries that 409) | 1 | 20/20 landed whole; 0 duplicated; 0 torn; 0 errors; wall 164.7 ms |

## Compute and snapshots

| Operation | n | ok | failed | Result | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| exec round trip (`true`, whole disk, conditional mount) | 5 | 5 | 0 | p50 98.6, p90 108.1, min 78.0, max 108.1 | server-side p50: total 46.0, queue 42.0, execute 3.0 |
| checkpoint (one exec of `archil checkpoints create`) | 1 | 1 | 0 | 167.5 ms | readable with `versionId` 9.6 s after the call returned (old value, as expected) |
| branch from that checkpoint (`createBranch`) | 1 | 1 | 0 | 67.9 ms | first read on the branch 418.3 ms (checkpoint state) |
| door up (`doorUp`: copy the runtime, create the sandbox, start the service, wait for /healthz, mint a port token) | 1 | 1 | 0 | 3779.2 ms | 1 vCPU, 1 GiB, node:24-bookworm |
| door, warm `GET /healthz` through the port token | 5 | 5 | 0 | p50 52.0, max 307.4 |  |
| door, warm `POST /events` (deliver, then a tick that runs one turn) | 3 | 3 | 0 | p50 275.4, max 280.4 | the stead's files are on the disk's FUSE mount |
| door, pause (`sandbox.pause()`) | 3 | 3 | 0 | p50 1243.4, max 1709.7 |  |
| door, paused sandbox woken by `GET /healthz` | 2 | 1 | 1 | 680.4 ms | request sent 2 s after the pause returned |
| door, paused sandbox woken by `POST /events` (wake, deliver, tick) | 1 | 1 | 0 | 864.7 ms | request sent 2 s after the pause returned |
| door, a second request right after a wake request failed | 1 | 1 | 0 | 818.9 ms | each sample is one attempt, capped at 30 s |

## Failures

- door wake /healthz: The door at https://8080-agq2uiupgbynlawt45awyfffte.prod-aws-us-west-2-green.archil.app didn't answer GET /healthz: The operation was aborted due to timeout

## Resources used

- Disks: 1 created (`stead-measure-tfapjp`), deleted. Its checkpoint and branch went with it.
- Exec calls: 6 (budget 10).
- Sandbox: 1, up for about 51 s wall time, deleted.
## Notes on this run and the others that day

This file is the third run of `scripts/measure.mjs` on 5 November 2026. The first two had bugs in the
script or its door client, both fixed before this run. Their valid numbers are kept here with their losses:

- **05:09Z.** The script's own timer read 0.0 ms for every operation it timed, because it computed
  the time before awaiting the call. The door samples, timed inside `callDoor`, were valid. Warm
  `GET /healthz` p50 was 48.3 ms (max 236.3), and warm `POST /events` p50 was 274.2 ms (max 285.3).
  Wakes: `GET /healthz` 679.1 ms, `POST /events` 1032.8 ms. One more `GET /healthz`, sent 2 s after
  the second pause, got no answer within 90 s.
- **05:14Z.** The object API, race, exec, checkpoint and branch numbers matched this run. Every door
  sample failed on a client bug: the door client passed a fractional timeout to
  `AbortSignal.timeout()`.

**Why a wake request hung.** In this run and the 05:09Z run, the wake request that failed was the
second one. It went out about 3 s after the previous request. A probe at 05:18Z found the cause.
A request on a keep-alive connection opened before the pause got no answer for 15 s, and the sandbox
stayed `paused`. The same request on a new connection woke it in 681 ms, and after another pause a new
connection woke it in 806 ms. Archil checks port tokens when a connection opens, and evidently wakes a
sandbox then too. So a client that keeps connections alive can sit on a dead connection to a paused
door. Node's `fetch` keeps them alive by default. `callDoor` now opens a new connection for every
request, and retries a repeatable request whose attempt gets no answer within 30 s. A new connection
costs the TLS setup: a warm `POST /events` took 394 ms that way, against about 275 ms over keep-alive.

**The door end to end through the CLI** (`test/live/door.test.ts`, 05:20Z, with the fixed client):

- `create`, `push`, `door up` and `door call` all ran through the CLI.
- The turn showed up in the journal through the object API and `stead log`.
- A paused door woken by `POST /events` answered in 947 ms.
- `stead status` and `stead send` from the laptop worked while the door was paused, and neither woke it.
- A door `POST /tick` woke the door in 949 ms and handled the event the laptop had sent through the
  object API. The tick's `archil invalidate-cache` made the new inbox file visible to the mount.
- `door down` deleted the sandbox. The disk was then deleted. The sandbox existed for 18.7 s.
