# Shared Atoll conventions

Atoll runs standing agents: work a person hands off that stays on duty, watches something, follows up,
waits for days without forgetting, and asks its owner when a decision needs a person. The agent is a
directory on an Archil disk. Compute is borrowed for each turn and thrown away, so any machine with the
disk's ID and a credential can run the next turn.

## The CLI

If `atoll` is absent from PATH, run `node <plugin-root>/bin/atoll.js` instead; it prefers the project's
installed `atoll` and falls back to the plugin's own build.

| Command | What it does |
| --- | --- |
| `atoll doctor [--online]` | Node, the Archil API key and region (never printed), and the project; with `--online`, whether Archil accepts the key |
| `atoll init <dir> [--template release-radar\|promise-keeper\|upgrade-steward\|blank]` | Scaffold a project; never overwrites a file |
| `atoll create <name>` | Lay out an empty atoll; with `--disk <name>`, create that Archil disk first. Where files already are, it shows the top level and stops (`--prefix`, `--alongside`) |
| `atoll push` | Check and bundle `system.ts`, store it on the atoll, make it current, checkpoint |
| `atoll send <to> <type> [json]` | Deliver an event |
| `atoll tick` | Run turns until the inbox is empty |
| `atoll status [address]` | The five answers, for the whole atoll or one part |
| `atoll why <path\|event-id\|seq>` | The turn that produced something, and its causes |
| `atoll log [--since <dur>] [--part <addr>]` | Turns and effect outcomes |
| `atoll asks` / `atoll answer <ask-id> <option> [--payload <json>]` | Questions for the owner, and answering one (then a tick) |
| `atoll check` | The declaration, the six promises, idle parts, files changed outside a turn |
| `atoll replay` / `atoll try` | Re-handle recorded turns through the code that recorded each one, or through the working copy's |
| `atoll fork [--checkpoint <name>]` / `atoll checkpoint <name>` | Branch or checkpoint the disk |
| `atoll door up\|down\|url\|token` | The sandbox that sleeps until a request wakes it; `up` says what it may reach and where its model keys are held |
| `atoll clock [--crontab\|--launchd\|--github\|--door] [--cron <expr>] [--write <path>]` | Print, or write without overwriting, configuration for something outside to call `atoll tick` |
| `atoll serve` | The door's HTTP server, for any machine |
| `atoll ls [prefix]` / `atoll cat <path>` | List or print an atoll's files through the object API, for a disk you can't mount |

Every command takes `--dir <path>` for a local atoll or `--disk <name-or-id>` for an Archil disk, and
`--json`. In a project without either flag, commands act on `.atoll-local/` at the project root, or on
the disk named by `"disk"` in the `atoll` field of `package.json`. Exit codes: 0 ok, 1 a check failed
(or a part is idle, for `status`), 2 usage, 3 not in an atoll project.

## What is on the disk

| Question | Where the answer lives | Read it without Atoll |
| --- | --- | --- |
| What is it trying to accomplish? | `CHARTER.md`, which `atoll push` writes from the declared charter and each part's purpose | `cat CHARTER.md` |
| What changed, and why? | `journal/<YYYY-MM-DD>.jsonl`: one record per turn and per effect outcome | `tail -n 5 journal/2026-11-04.jsonl` |
| What is it waiting for? | `parts/<address>/waiting.json` and `.atoll/next-wake` | `cat parts/watch/rivetkit/waiting.json` |
| What evidence supports its state? | `evidence/<hh>/<sha256>`, cited by hash from the journal | `grep -rl rivetkit evidence/` |
| What does it need from me? | `asks/` and `outbox/` | `ls asks/ outbox/` |

Events wait in `inbox/` (and `inbox/dead/` after three failed attempts), notices in `notices/<day>/`,
untrusted commands run in `workspace/`, and `.atoll/` holds the lease, the code, the timers, and the
meter.

## The declaration and the Turn API

`system.ts` default-exports `defineSystem({ name, charter?, owner?, parts, effects? })` from `atoll`.
With a `charter`, every push makes the disk's `CHARTER.md` exactly `# <name>`, the charter, then
`## Parts` with one line per part, `- **<part>**: <purpose>.`; keep the project's `CHARTER.md` identical,
and test that a new atoll's `CHARTER.md` equals it.

- A **part** has a `purpose` in the owner's voice, `instances: true` for one directory per instance under
  `parts/<part>/<instance>/`, `schedules` (`{ every: "1h", send }` or `{ cron, tz?, send }`), and `on`,
  its handlers keyed by event type. The runtime delivers `timer`, `ask.answered`, and `ask.expired`.
- An **effect** has a `kind` (`http`, `exec`, `model`, `notify`, `custom`) and a policy: `approval`,
  `idempotent` (default true only for http GET and HEAD and for notify), `budget`
  (`{ calls?, usd?, per: "day" | "month" }`), `allow` hosts for http and for any effect that reaches the
  network from a door (a door's network policy admits only the hosts its effects list), `scope` for exec
  (default `workspace`), `fork` to run a command on a branch and merge it back only if nothing else wrote
  the same files, `merge: false` to leave a forked command's changes on its branch when its outcome is a
  verdict, `ignore` for directories such as `node_modules` that the runner shouldn't walk, `model`,
  `maxUsd`, and `standIn` for a model, `describe` for an approval's question, and `run(args, ctx)` for
  custom.
- A **handler** is `(t, e) => void | Promise<void>`. `t.event`, `t.self`, `t.part`, `t.instance`, and
  `t.now` describe the turn. `t.read`, `t.bytes`, `t.json`, and `t.list` read files (relative paths are
  under the part's directory, `/...` is from the atoll's root), and `t.readEvidence(ref)` reads a
  receipt as text. `t.write` and `t.delete` change files
  under the part's own directory. `t.send(to, type, body?, { evidence? })`,
  `t.effect(name, args, { then?, key? })`, `t.wait({ until?, for?, ask?, reason })`, `t.done(reason?)`,
  `t.ask({ question, why, options, recommend?, default, expires, payload?, evidence? })`,
  `t.tell(text)`, `t.evidence(content, { source, type? })`, and `t.note(text)` are buffered and commit
  together as one journal record.
- **Waits.** The waits a turn declares with `t.wait` replace the part's earlier ones; a turn that
  declares none keeps those its event didn't satisfy. Schedules re-arm after every turn, so a scheduled
  part always waits for its next firing, until `t.done` clears every wait, schedules included. A part
  that is neither waiting nor done is idle, and `atoll check` flags it.
- **Results.** An effect's result comes back to the requesting instance as its `then` event (default
  `<name>.done`), with the body `{ ok, effect, name, result, error, denied }`. For http, `result` holds
  `status`, `json` (or `text`), and `body`, the evidence reference for the whole answer; an answer is `ok`
  whatever its status, so check `result.status`. Pass `pick: ["field", "nested.field"]` with a polled
  request so the result keeps only those fields; without it, an answer over 16 KiB, like any result over
  64 KiB, arrives as `tooLarge: true`, read with `t.readEvidence(result.body)`. For a model, `result`
  holds `json`, `text`, and `standIn`; for custom, what `run` returned. An approval's ask has the
  options `approve` and `deny` and defaults to `deny` after three days; denial delivers `denied: true`,
  and the part sees only the effect's result, never the approval's answer.

```ts
// atoll:check system.ts
import { defineSystem } from "@standing-systems/atoll";

export default defineSystem({
  name: "release-watch",
  parts: {
    watch: {
      purpose: "Tell me about each new version of this package on npm",
      instances: true,
      schedules: [{ every: "1h", send: "watch.poll" }],
      on: {
        "watch.poll": (t) => {
          t.effect("npm.get", { url: `https://registry.npmjs.org/${t.instance}/latest`, pick: ["version"] }, { then: "watch.fetched" });
          t.wait({ for: "watch.fetched", reason: "the registry's answer" });
        },
        "watch.fetched": async (t, e) => {
          // The schedule keeps this part waiting for its next poll, so this turn declares no wait.
          const result = e.body?.result;
          if (!e.body?.ok || result?.status !== 200) {
            t.note(`npm didn't answer: ${e.body?.error ?? `status ${result?.status}`}`);
            return;
          }
          const latest = result.json?.version;
          const seen = await t.json<{ version: string }>("latest.json");
          if (typeof latest === "string" && latest !== seen?.version) {
            t.write("latest.json", { version: latest });
            t.tell(`${t.instance} ${latest} is out.`, { evidence: e.evidence });
          }
        },
      },
    },
  },
  effects: {
    "npm.get": { kind: "http", allow: ["registry.npmjs.org"], budget: { calls: 5000, per: "month" } },
  },
});
```

## Testing with @standing-systems/atoll/testing

`testAtoll(system, { now, stubs })` runs the system on a temporary local atoll with a controlled clock.
Every effect a test reaches needs a stub, except a model effect with a `standIn`, which answers with
its stand-in; a stub's return value becomes the result exactly. The calls are
`s.send(to, type, body)`, `s.tick()`, `s.advance("1h")`, `s.read(path)` and `s.json(path)` (from the
atoll's root), `s.list(prefix)`, `s.status()`, `s.asks()`, `s.answer(id, option, payload?)` (then a
tick), `s.calls(name?)`, `s.journal()`, and `s.close()`.

```ts
// atoll:check test/release-watch.test.ts
import { expect, it } from "vitest";
import { testAtoll } from "@standing-systems/atoll/testing";
import system from "../system.ts";

it("tells me about a new version once, however many polls see it", async () => {
  const s = await testAtoll(system, {
    now: "2026-11-04T09:00:00Z",
    stubs: { "npm.get": () => ({ status: 200, json: { name: "rivetkit", version: "3.0.1" } }) },
  });
  try {
    await s.send("watch/rivetkit", "watch.poll", {});
    await s.tick();
    await s.advance("90m");
    expect(s.calls("npm.get")).toHaveLength(2);
    const told = (await s.journal()).flatMap((r) => (r.kind === "turn" ? r.notices.map((n) => n.text) : []));
    expect(told).toEqual(["rivetkit 3.0.1 is out."]);
    expect((await s.status()).idle).toEqual([]);
  } finally {
    await s.close();
  }
});
```

## Rules that always hold

- Never push code, create a disk, start a door, or install a clock on your own. Asked to deploy or run an
  atoll, answer with the plan and the exact commands for the person to run.
- Handlers never call `fetch`, `Date.now()`, `Math.random()`, or anything else outside the Turn API. All
  I/O is a declared effect; the time is `t.now`.
- Every effect that reaches another person or speaks for the owner has `approval: true`; every effect
  that costs money or counts against a plan has a budget; model output is checked before code acts on it.
- Keep existing tests as they are, and add one focused test that proves each change.
- Never print, ask for, or write the Archil API key or a door's port token.

## What Atoll guarantees, and what it doesn't

It guarantees that a turn's file changes, sends, effects, waits, and asks happen together or not at all;
that an event ID is handled at most once within 30 days; that every delivered event is eventually
handled, retried, or dead-lettered with a notice; one runner at a time; that an effect is never reported
done without a recorded outcome; that an approved effect runs once with exactly the approved arguments;
that a budget is never exceeded by an effect that hasn't run; that a timer fires once per due time; and
that replaying the journal through the same code reproduces the same files.

It does not guarantee exactly-once external effects (an effect whose outcome is unknown is reported in
doubt, and the owner is asked), ordering across senders, a consistent view of files mid-tick, exact
timing (a wait fires at the first tick after it is due), or isolation of untrusted code from someone who
holds the disk's API key.
