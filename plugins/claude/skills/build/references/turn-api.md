# The declaration and the Turn API

Everything here comes from `atoll`: `import { defineSystem } from "@standing-systems/atoll"`, plus the types `SystemSpec`,
`PartSpec`, `ScheduleSpec`, `EffectSpec`, `BudgetSpec`, `Handler`, `Turn`, `AtollEvent`, `WaitSpec`, and
`AskSpec` for code that needs them.

## The declaration

`system.ts` default-exports `defineSystem({...})`, which returns the spec unchanged.

| Field | What it holds |
| --- | --- |
| `name` | Lowercase letters, digits, and hyphens, starting with a letter: `release-radar` |
| `charter` | What the atoll is for, in the owner's words. `atoll push` writes the disk's `CHARTER.md` from it (below) and keeps it in step |
| `owner` | `{ name?, timezone? }`. The time zone is the default for `cron` schedules, else UTC |
| `parts` | Each part by name (lowercase letters, digits, and hyphens): `purpose`, `instances`, `schedules`, `on` |
| `effects` | Each effect by name (dotted lowercase words, such as `npm.get`): `kind` and its policy |

With a `charter`, every push makes the disk's `CHARTER.md` exactly `# <name>`, a blank line, the charter,
a blank line, `## Parts`, a blank line, and one line per part, `- **<part>**: <purpose>.`, so the purposes
carry no closing period of their own. Without one, push writes that file once with a placeholder in place
of the charter, and leaves it alone after that. Keep the project's `CHARTER.md` identical to what push
writes, and test it: a new atoll's `CHARTER.md` (`await s.read("CHARTER.md")`) equals the file beside
`system.ts`.

A part has:
- `purpose`: what it does, as a plain sentence in the owner's voice, such as "Tell me about each new
  version of this package on npm". `atoll check` rejects a missing or too-short one.
- `instances: true` for one directory per instance under `parts/<part>/<instance>/`, created by the first
  event addressed to it. Instance names match `[a-z0-9][a-z0-9._-]{0,63}`. Events to such a part name an
  instance (`watch/rivetkit`); events to a singleton don't (`ledger`).
- `schedules`: `{ every: "1h", send: "watch.poll" }`, or
  `{ cron: "0 9 * * 1", tz: "Europe/London", send: "digest.write", body: {} }`, with exactly one of
  `every` or `cron`, and a handler for the `send` type.
- `on`: handlers keyed by event type, in dotted lowercase words such as `watch.poll`. The runtime itself
  delivers three types: `timer` (a due wait), `ask.answered`, and `ask.expired`.

An effect has a `kind` and a policy:

| Field | Applies to | Meaning |
| --- | --- | --- |
| `kind` | all | `http`, `exec`, `model`, `notify`, or `custom` |
| `approval` | all | Wait for the owner's approval, then run once with exactly the approved arguments |
| `idempotent` | all | Safe to retry after an interruption. Defaults to true for http GET and HEAD and for notify, false otherwise |
| `budget` | all | `{ calls?, usd?, per: "day" }` or `per: "month"`, with at least one of `calls` and `usd` |
| `describe` | approvals | `(args) => string`: a plain sentence saying what running it will do, used as the approval's question |
| `allow` | http; any kind run from a door | The hosts it may reach, such as `registry.npmjs.org` or `*.example.com`. Required for http, where the runner checks each request. A door's network policy admits the hosts any effect lists and no others, so a custom or exec effect that reaches the network from a door lists them too |
| `scope` | exec | The directory the command's mount is limited to. Defaults to `workspace` |
| `fork` | exec | Run on a branch, and merge back only if nothing else wrote the same files |
| `merge` | exec with `fork` | `false` leaves what the command did on its branch and copies nothing back: the result names the branch, whether the command passed or failed. For a trial, whose outcome is a verdict. Defaults to true |
| `ignore` | exec | Directory names, such as `node_modules`, that the runner doesn't look into when it works out what a command changed. Changes there aren't reported, and a forked command's changes there stay on its branch |
| `model` | model | `"stand-in"`, `"anthropic/<model>"`, or `"openai/<model>"` |
| `maxUsd` | model | The most one call may cost, counted against the budget when the price is unknown |
| `standIn` | model | `(args) => answer`: a deterministic answer used when the runner has no key for the model, and in tests. Without one, a call on a runner without the key fails, and costs nothing |
| `run` | custom | `(args, ctx) => result`, run by the trusted runner. `ctx` has `id`, `key`, `now`, and `evidence()` |

What each kind takes as arguments, and what its result holds:

| Kind | Arguments | Result |
| --- | --- | --- |
| `http` | `url`, and optionally `method` (default GET), `headers`, `body`, and `pick` (dotted paths such as `["version", "dist-tags.latest"]`) | `status`, `headers`, `json` (or `text` when the answer isn't JSON), `body` (the evidence reference for the whole answer), and `bytes`. With `pick`, `json` holds only those fields. Without it, an answer over 16 KiB arrives as `tooLarge: true` with no `json` or `text` |
| `exec` | `command` | `exitCode`, `stdout`, `stderr`, `truncated`, `changed` (the files the command added, modified, or deleted) |
| `model` | `prompt`, and optionally `system` and `schema` (a JSON schema for the answer) | `json`, `text`, `model`, `standIn` (true when the stand-in answered) |
| `notify` | `text`, and optionally `title` | `delivered`; it posts to `ATOLL_NOTIFY_URL` when the runner has one |
| `custom` | whatever `run` takes | whatever `run` returns; a `run` that throws is a failed effect |

## The Turn API

A handler is `(t, e) => void | Promise<void>`, and one turn handles exactly one event. Reads go to the
disk, and see this turn's own writes. Everything else is buffered and committed as one journal record, so
a turn's writes, sends, effects, waits, asks, and notices happen together or not at all.

| Member | What it does |
| --- | --- |
| `t.event` | The event being handled, also passed as `e`: `id`, `type`, `to`, `from`, `cause`, `at`, `body`, `evidence` |
| `t.self`, `t.part`, `t.instance` | This instance's address (`watch/rivetkit`), its part (`watch`), and its instance name (`""` for a singleton) |
| `t.now` | The turn's time. Replays see the recorded time, so use it and never `Date.now()` |
| `t.read(path)`, `t.bytes(path)`, `t.json<T>(path)` | Read a file, or `null` when there is none. A relative path is under this part's directory; a path starting with `/` is from the atoll's root |
| `t.list(dir?)` | The file paths under a directory, relative to it |
| `t.readEvidence(ref)` | Read a receipt by its reference (`sha256:<hex>`) as text, such as an http answer too large to inline |
| `t.write(path, data)` | Write a file under this part's directory. Objects are written as JSON |
| `t.delete(path)` | Delete a file under this part's directory |
| `t.send(to, type, body?, { evidence? })` | Send an event to a declared part that handles `type`. Returns the new event's ID |
| `t.effect(name, args, { then?, key? })` | Request a declared effect. It runs after this turn commits, and its result comes back to this instance as a `then` event (default `<name>.done`). `key` sets the idempotency key, which is otherwise derived from the turn. Returns the effect's ID, such as `fx42.0` |
| `t.wait({ until?, for?, ask?, reason })` | Wait until a time (a Date, an ISO string, or a duration such as `"15m"`, `"2h"`, `"3d"`), for an event type addressed to this part, or for an ask's answer. `reason` is a plain sentence. The waits a turn declares replace the part's earlier ones |
| `t.done(reason?)` | This instance's work is finished. It clears every wait, schedules included |
| `t.ask({...})` | Ask the owner a question (below). Returns the ask's ID, such as `q42.1` |
| `t.tell(text, { evidence? })` | Tell the owner something: a notice under `notices/<day>/` |
| `t.evidence(content, { source, type? })` | Capture a receipt. Returns its reference, `sha256:<hex>` |
| `t.note(text)` | Say why this turn did what it did, for the journal and `atoll why` |

## Waits

A turn that declares waits says what its part waits for now: the waits it declares with `t.wait(...)`
replace the part's earlier ones. A turn that declares none keeps the earlier waits its event didn't
satisfy. An event satisfies an `until` wait when it is that wait's `timer`, a `for` wait when it has that
type, and an `ask` wait when it answers that ask or reports its expiry. Schedules are separate: the
runtime re-arms a part's schedules after every turn, so a scheduled part always waits for its next firing
without being told, unless it calls `t.done()`. A missed schedule fires once on the next tick, not once per
missed period. A singleton part's schedules are armed when code is pushed, and an instance's when it
handles its first event.

A part that is neither waiting nor done is idle, and `atoll check` flags it, as it flags an `until` wait on
a part without a `timer` handler and a `for` wait on a type the part doesn't handle. A part that is done
and then handles another event is idle again, or waiting on its schedules if it has any, unless that turn
declares a wait or calls `t.done` again.

## Effect results

The `then` event's body is `{ ok, effect, name, result, error, denied }`. `ok` says whether the effect ran
and returned, `result` is what the kind returned (the table above), `error` says why it didn't, and
`denied` is true when the owner said no or let the approval expire. Check `e.body.ok` first, then read
`e.body.result`, and treat anything else as not done.

- **An http answer is `ok` whatever its status.** A 404 or a 500 arrives with `ok: true` and
  `result.status`, so check the status before reading `result.json`.
- **Large answers stay in the evidence.** Give a polled request `pick`, so the result keeps only the
  fields the handler reads while the evidence keeps the whole answer. A result with `tooLarge: true`
  carries only `body`, its evidence reference: read it with `await t.readEvidence(e.body.result.body)`.
  Any result over 64 KiB, of any kind, arrives the same way, as `{ tooLarge: true, bytes, body }`.
- **In doubt.** When the runner can't know whether an effect happened, it asks the owner. "It happened"
  delivers `ok: true` with `result: { assumed: true, by: "owner" }`; "leave it unknown", the default,
  delivers `ok: false` with `result: { inDoubt: true }`; "run it again" runs it again.

## Asks and approvals

`t.ask` takes `question`, `why`, `options` (each `{ id, label, consequence }`), `recommend`, `default`,
`expires` (a Date, an ISO string, or a duration such as `"3d"`), and optionally `payload` (data the owner
may edit before answering, such as a draft) and `evidence`. `default` and `expires` are required, so the
owner is never a hard bottleneck. The answer comes back to the asking part as `ask.answered`, and an ask
that expires resolves with its default as `ask.expired`. Both bodies are `{ ask, option, payload, by }`.

An effect with `approval: true` asks by itself. The runner writes `outbox/<fx>.json` with the exact
arguments and opens an ask with the options `approve` and `deny`, defaulting to `deny` after three days,
with the arguments as its payload. Approving with an edited payload runs the effect once with the edit;
denying, or letting it expire, delivers the result event with `denied: true`. The part never sees the
approval's answer, only the effect's result. An effect that would pass its budget opens an ask too
(`allow` or `drop`, defaulting to `drop`).

## What fails a turn

A turn whose handler throws, writes outside its part's directory (or writes `waiting.json`, which belongs
to the runtime), sends to an undeclared part or a type that part doesn't handle, or requests an undeclared
effect, commits nothing and is recorded as a failure. The event stays in the inbox and is tried again on
the next tick; after three failures it moves to `inbox/dead/`, and the owner gets a notice. An event
addressed to a part or a type the code doesn't have goes to `inbox/dead/` at once.

`atoll check` also warns when a handler's own code calls `fetch(`, reads `Date.now()` or an
argument-less `new Date()`, calls `Math.random()`, or names a network or process module. It reads each
handler's source, not the helpers a handler calls, so hold those helpers to the same rules. A custom
effect's `run` isn't scanned: outside calls belong there.

## A watcher, a ledger, and a digest

Instances, a schedule, an idempotent http effect that picks one field and keeps the whole answer as
evidence, a ledger that dedupes by business key, a notice, and a digest that reads another part's files
instead of asking it for them.

```ts
// atoll:check system.ts
import { defineSystem } from "@standing-systems/atoll";

interface Release {
  name: string;
  version: string;
  at: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export default defineSystem({
  name: "release-watch",
  owner: { timezone: "Europe/London" },
  parts: {
    watch: {
      purpose: "Tell me about each new version of this package on npm",
      instances: true,
      schedules: [{ every: "1h", send: "watch.poll" }],
      on: {
        "watch.poll": (t) => {
          // pick keeps only the version in the result; the evidence keeps npm's whole answer.
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
            t.send("ledger", "release.seen", { name: t.instance, version: latest }, { evidence: e.evidence });
            t.note(`${t.instance} ${latest} is new`);
          }
        },
      },
    },
    ledger: {
      purpose: "Keep a list of every release my watchers find, and tell me about each one once",
      on: {
        "release.seen": async (t, e) => {
          const { name, version } = e.body as { name: string; version: string };
          const releases = (await t.json<Release[]>("releases.json")) ?? [];
          if (releases.some((r) => r.name === name && r.version === version)) {
            t.note(`${name} ${version} is already in the ledger`);
          } else {
            t.write("releases.json", [...releases, { name, version, at: t.now.toISOString() }]);
            t.tell(`${name} ${version} is out.`, { evidence: e.evidence });
          }
          t.wait({ for: "release.seen", reason: "the next release a watcher finds" });
        },
      },
    },
    digest: {
      purpose: "Give me a list of the week's releases every Monday morning",
      schedules: [{ cron: "0 9 * * 1", send: "digest.write" }],
      on: {
        "digest.write": async (t) => {
          // Parts read each other's files directly, so the ledger needs no event for this.
          const releases = (await t.json<Release[]>("/parts/ledger/releases.json")) ?? [];
          const recent = releases.filter((r) => t.now.getTime() - Date.parse(r.at) < WEEK_MS);
          const text = recent.length
            ? `This week's releases:\n${recent.map((r) => `- ${r.name} ${r.version}`).join("\n")}`
            : "No new releases this week.";
          t.write(`${t.now.toISOString().slice(0, 10)}.md`, text);
          t.tell(text);
        },
      },
    },
  },
  effects: {
    "npm.get": { kind: "http", allow: ["registry.npmjs.org"], budget: { calls: 5000, per: "month" } },
  },
});
```

## An approval, an ask with a default, and a custom effect

The note goes out only after the owner approves the exact text. If they deny it, or it can't be sent, the
part asks whether to keep tracking the promise, and keeps tracking it if nobody answers.

```ts
// atoll:check follow-up.ts
import { defineSystem, type Handler } from "@standing-systems/atoll";

interface Promised {
  what: string;
  to: string;
  due: string;
}

// An answered ask and an expired one both carry the chosen option; an expired ask chose its default.
const decide: Handler = (t, e) => {
  if (e.body?.option === "drop") {
    t.delete("promise.json");
    t.done("you dropped it");
  } else {
    t.wait({ until: "2d", reason: "two more days before I draft another note" });
  }
};

export default defineSystem({
  name: "follow-up",
  parts: {
    promise: {
      purpose: "Remind me of what I promised, and ask me before I remind anyone else",
      instances: true,
      on: {
        "promise.made": async (t, e) => {
          // The same promise sent twice is tracked once: the first one's wait still holds.
          if (await t.json<Promised>("promise.json")) {
            t.note("I already track this promise");
            return;
          }
          const { what, to, due } = e.body as Promised;
          t.write("promise.json", { what, to, due });
          t.wait({ until: due, reason: `the day I promised ${to} ${what}` });
        },
        timer: async (t) => {
          const promise = await t.json<Promised>("promise.json");
          if (!promise) {
            t.done("there is nothing to follow up");
            return;
          }
          // mail.send needs approval, so the runner asks me about exactly these arguments first.
          const text = `Hi ${promise.to}, a quick note about ${promise.what}.`;
          t.effect("mail.send", { to: promise.to, text }, { then: "mail.sent" });
          t.wait({ for: "mail.sent", reason: "your approval of the note, then the mail API's answer" });
        },
        "mail.sent": async (t, e) => {
          const promise = await t.json<Promised>("promise.json");
          if (e.body?.ok) {
            t.tell(`I sent ${promise?.to} the note you approved.`, { evidence: e.evidence });
            t.delete("promise.json");
            t.done("the note went out");
            return;
          }
          const id = t.ask({
            question: `Keep tracking your promise to ${promise?.to} about ${promise?.what}?`,
            why: e.body?.denied
              ? "You didn't approve the note, so nothing was sent."
              : `I couldn't confirm the note went out: ${e.body?.error ?? "no reason recorded"}.`,
            options: [
              { id: "keep", label: "Keep tracking it", consequence: "I draft another note in two days and ask you again." },
              { id: "drop", label: "Drop it", consequence: "I stop tracking this promise." },
            ],
            recommend: "keep",
            default: "keep",
            expires: "3d",
          });
          t.wait({ ask: id, reason: "your answer about the promise" });
        },
        "ask.answered": decide,
        "ask.expired": decide,
      },
    },
  },
  effects: {
    "mail.send": {
      kind: "custom",
      approval: true,
      // A retry is safe only because the mail API honors the Idempotency-Key header sent below.
      idempotent: true,
      budget: { calls: 20, per: "month" },
      describe: (args) => `Email ${args.to}: "${args.text}"`,
      // Runs in the trusted runner after the turn commits, never inside a handler.
      run: async (args, ctx) => {
        const res = await fetch("https://mail.example.com/v1/send", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": ctx.key },
          body: JSON.stringify({ to: args.to, text: args.text }),
        });
        if (!res.ok) throw new Error(`the mail API answered ${res.status}`);
        return { status: res.status };
      },
    },
  },
});
```

## A model that proposes and code that decides

A `model` effect with a stand-in, a budget in dollars, and a ceiling per call. The answer is checked
before any part acts on it, and each accepted promise gets its own instance.

```ts
// atoll:check promise-finder.ts
import { defineSystem } from "@standing-systems/atoll";

interface Found {
  what: string;
  to: string;
  due: string;
}

const answer = {
  type: "object",
  properties: {
    promises: {
      type: "array",
      items: {
        type: "object",
        properties: { what: { type: "string" }, to: { type: "string" }, due: { type: "string" } },
        required: ["what", "to", "due"],
      },
    },
  },
  required: ["promises"],
};

function isFound(x: unknown): x is Found {
  const p = x as Partial<Found> | null;
  return typeof p?.what === "string" && typeof p.to === "string" && typeof p.due === "string" && !Number.isNaN(Date.parse(p.due));
}

// Instance names match [a-z0-9][a-z0-9._-]{0,63}.
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "promise";
}

export default defineSystem({
  name: "promise-finder",
  parts: {
    reader: {
      purpose: "Read the messages I forward and find the promises I made in them",
      on: {
        "message.received": (t, e) => {
          const text = String(e.body?.text ?? "");
          const message = t.evidence(text, { source: "owner", type: "text/plain" });
          const prompt = `List each promise the sender made in this message: what, to whom, and the due date.\n\n${text}`;
          t.effect("promises.find", { prompt, schema: answer }, { then: "promises.found" });
          t.note(`asked the model for the promises in ${message}`);
          t.wait({ for: "promises.found", reason: "the model's reading of the message" });
        },
        "promises.found": (t, e) => {
          // The model proposes; this code decides what counts as a promise.
          const proposed: unknown[] = e.body?.ok && Array.isArray(e.body.result?.json?.promises) ? e.body.result.json.promises : [];
          const accepted = proposed.filter(isFound);
          for (const p of accepted) t.send(`promise/${slug(p.what)}`, "promise.made", p, { evidence: e.evidence });
          t.note(`kept ${accepted.length} of ${proposed.length} proposed promises`);
          t.wait({ for: "message.received", reason: "the next message you forward" });
        },
      },
    },
    promise: {
      purpose: "Remind me of each promise I made on the day it falls due",
      instances: true,
      on: {
        "promise.made": async (t, e) => {
          const known = await t.json<Found & { reminded?: boolean }>("promise.json");
          if (known) {
            // Found again in a later message: keep the first one's wait, or stay done.
            t.note("I already track this promise");
            if (known.reminded) t.done("I already reminded you");
            return;
          }
          const p = e.body as Found;
          t.write("promise.json", p);
          t.wait({ until: p.due, reason: `the day it is due, ${p.due}` });
        },
        timer: async (t) => {
          const p = await t.json<Found>("promise.json");
          if (p) {
            t.tell(`Due today: ${p.what}, for ${p.to}.`);
            t.write("promise.json", { ...p, reminded: true });
          }
          t.done("I reminded you");
        },
      },
    },
  },
  effects: {
    "promises.find": {
      kind: "model",
      // "anthropic/<model>" or "openai/<model>" once a key is configured; the stand-in needs none.
      model: "stand-in",
      maxUsd: 0.05,
      budget: { usd: 5, per: "month" },
      standIn: () => ({ promises: [] }),
    },
  },
});
```
