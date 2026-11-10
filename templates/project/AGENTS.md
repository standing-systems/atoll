# __ATOLL_NAME__

An atoll: a standing agent whose state lives in files on an Archil disk, built with atoll.
- `system.ts` declares the parts, their handlers, effects, schedules, and budgets. `CHARTER.md` says what it is for and what it must never do, in my words; `system.ts` carries the same words as its `charter`, which `atoll push` writes to the disk, so change them together (a test checks they match).
- `npm test` runs the tests in `test/` against a local atoll (`@standing-systems/atoll/testing`, with stubbed effects and a clock the test controls). `npx --no-install atoll check` checks the declaration, the six promises, and the project's atoll. `npm run verify` runs both: run it before reporting a change as done.
- Handlers never call `fetch`, `Date.now()`, or anything else that reaches outside. All I/O is an effect declared in `system.ts` and requested with `t.effect`, and the time is `t.now`.
- Every part is always waiting for something (`t.wait`) or done (`t.done`).
- When adding behavior, keep the existing tests as they are, and add one focused test that proves the change.
- Never push code, create a disk, start a door, or install a clock on your own: `atoll push`, `atoll create`, `atoll door up`, and `atoll clock` are mine to run. Asked to deploy or run it, answer with the plan and the exact commands.
- `atoll status`, `atoll why`, `atoll log`, and `atoll asks` say what it is doing and why. They act on the local atoll in `.atoll-local/` until `package.json` names a disk.
