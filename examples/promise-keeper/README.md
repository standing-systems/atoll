# Promise keeper

Promise keeper keeps track of the promises people make me. I forward it a message, and it asks a model
to read the message and propose the promises in it. Its own rules decide which to keep. Each promise
it keeps gets its own instance, which waits until the promise is due. Then it asks me whether to send
a reminder, with a draft I can edit. If I say send, the reminder still needs my approval of its exact
text, and it goes out once, with exactly the text I approved.

| Part | Instances | What it keeps | What it waits for |
| --- | --- | --- | --- |
| `intake` | One | `pending/<effect>.json` while a message is being read, and `messages/<event>.json`: each message, with every proposed promise it kept or rejected and why | The next message, and each reading in progress |
| `promise` | One per promise, named for who and what, such as `promise/sam-rivera-send-you-the-deck` | `promise.json`: who, what, when it's due, where a reminder goes, and where things stand | The due time, then my answer, then my approval |

## How it decides

Models propose; code decides. The `extract` effect asks for `{ promises: [{ who, what, due }] }`, and
`checkPromise` in `system.ts` judges each proposal on its own. It rejects a promise that doesn't say
what was promised, a due date that isn't an ISO 8601 date, one that has already passed, and one more
than a year away. It keeps at most ten promises from one message. The message's record in
`parts/intake/messages/` lists every rejection with its reason, so I can see what the model suggested
and why it wasn't kept. A reading covers the first 6,000 characters of a message, where the newest
part of a forwarded thread is, so that one reading's cost has a ceiling; the record says when a
message was longer than that.

`extract` names `anthropic/claude-opus-5-5`. When the runner has `ANTHROPIC_API_KEY`, Claude reads the
messages. Without it, the stand-in in `extract.ts` answers instead. It is a plain reader for
first-person promises with a time, such as "I'll send you the deck by Friday" or "we will call you
tomorrow". Both resolve dates in my time zone (`TIME_ZONE` in `system.ts`, America/Los_Angeles), and a
promise with no time of day is due at 17:00. Each answer is kept as evidence and says which of the two
gave it.

A promise is named for who made it and what they promised, so the same promise in a later message
finds the same instance. If its due date moves ("I'll send you the deck by next Tuesday"), the promise
moves with it rather than becoming a second one.

When a promise is due, it asks me one question with three answers: send the reminder, wait two more
days, or drop it. It recommends waiting. If I don't answer within two days, it waits, then asks again.
If I answer send, the reminder goes through `reminder.send`, an effect declared with `approval: true`.
The runner opens a second question showing the exact arguments, and nothing goes out until I approve
them. I can edit the text in either question. An approval I don't answer within three days counts as
no, and the promise asks me again two days later.

`reminder.send` posts the approved text as JSON (`to`, `text`, `promise`, `key`) to the URL in
`PROMISE_KEEPER_WEBHOOK`, with an `Idempotency-Key` header, from whichever machine runs `atoll tick`.
Its receipt records only the URL's origin, since webhook URLs often carry a secret. Without the
variable, nothing is sent: the promise tells me it couldn't send the reminder and gives me the
approved text to send myself. A webhook that takes the request and then goes quiet may have sent it,
so the promise says the reminder may or may not have gone out, rather than calling it unsent.

## Run it locally

From this directory, with the Atoll CLI installed:

```bash
atoll push --dir .atoll-local
atoll send --dir .atoll-local intake message.received '{"from": "Sam Rivera <sam@example.com>", "text": "Thanks for the call. I will send you the deck by Friday."}'
atoll tick --dir .atoll-local
atoll status --dir .atoll-local
```

`.atoll-local/` is a project's default local atoll, and it is gitignored, so `--dir` is optional
here. A message without `at` is taken as sent when it arrives. After the tick, `parts/intake/messages/`
holds the message and what was kept, and `promise/sam-rivera-send-you-the-deck` waits until Friday at 17:00.
Tick after that and the question appears:

```bash
atoll asks --dir .atoll-local
atoll answer --dir .atoll-local <ask-id> send --payload '{"draft": "Hi Sam, any news on the deck?"}'
atoll asks --dir .atoll-local
atoll answer --dir .atoll-local <approval-id> approve
```

The tests walk through all of this in simulated time, without the network:

```bash
npm test
```

In the Atoll repository itself, run `npm test -- examples/promise-keeper` from the root.

## Run it on Archil

You need an Archil account, with `ARCHIL_API_KEY` and `ARCHIL_REGION` set in your environment or in
this project's `.env`, which its `.gitignore` already ignores.
`atoll doctor` checks both without printing either. Then, from this directory:

```bash
atoll create promise-keeper --disk promise-keeper
atoll push --disk promise-keeper
atoll send --disk promise-keeper intake message.received '{"from": "Sam Rivera <sam@example.com>", "text": "I will send you the deck by Friday."}' --tick
```

Archil has no timers, so something outside has to call `atoll tick`, or due promises and expired
questions wait until something does. Both of these print the configuration rather than install it:

```bash
atoll clock --disk promise-keeper --crontab
atoll clock --disk promise-keeper --github
```

Whatever runs the clock is the runner, so `ANTHROPIC_API_KEY` and `PROMISE_KEEPER_WEBHOOK` belong in
its environment: the crontab's env file, or secrets added to the GitHub workflow's step (`atoll clock
--github` names `ANTHROPIC_API_KEY`, because `extract` uses it). Messages can also arrive by webhook
through a door (`atoll door up`, then `POST /events`). `atoll door up` takes `ANTHROPIC_API_KEY` from
your environment or `.env` for the door, since the code calls Claude with it, and nothing else of yours.
So the door has no `PROMISE_KEEPER_WEBHOOK`, and a reminder approved there comes back to you to send. Its
sandbox couldn't post to your webhook anyway. On an Archil plan that can set a network policy it reaches
only the hosts the code's effects declare, which here is Anthropic's API, and Archil adds the key to those
requests so the door never holds it. On the Free plan it reaches only an allowlist of registries, Git
hosts, and model APIs.

## What it costs on the Free plan

Archil charges nothing. The Free plan includes five disks of up to 10 GB each, 1,000 tool calls, and
one sandbox-hour a month. Promise keeper uses one disk. Its turns read and write files through the
object API, which isn't a tool call, and its model calls and webhook posts come from the machine that
runs `atoll tick`. The only tool call is the checkpoint `atoll push` takes, one per push
(`--no-checkpoint` skips it). One promise, from the message to the reminder sent, leaves about 32 KB
on the disk.

The model is billed by Anthropic, not Archil, and only when the runner has `ANTHROPIC_API_KEY`;
without it, the stand-in reads messages for nothing. The budget allows $1 a month. A reading reads at
most 6,000 characters and answers in at most 2,000 tokens, which at Claude Opus 5.5's list prices ($4
per million input tokens, $20 per million output) comes to at most about $0.05 for English text. That
is `maxUsd`, and since the runtime doesn't know Claude's prices, it counts every reading at that
ceiling: 20 readings a month, after which the budget holds the next one and asks me whether to let it
run. A short message really costs about a cent to read, so raising the budget, or choosing a cheaper
model with a lower `maxUsd`, stretches it further.
