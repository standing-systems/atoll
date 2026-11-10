---
name: verify
description: Run this atoll project's checks and tests (atoll check, then vitest) before committing or before reporting work as done.
---

1. Run `npm run verify`. It runs `atoll check`, then the tests with `vitest run`.
2. Report the result as it is: each `atoll check` error with its code and where it is, and each failing test with its message. A run that couldn't start is not a pass; say what stopped it.
3. Don't commit or report the work as done while anything fails. Fix the cause, or say plainly what still fails. Each warning from `atoll check` needs a fix or a reason.

`atoll check` reads the declaration and the project's atoll (the local one in `.atoll-local/`, or the disk that `package.json` names) and changes neither. Verification never pushes code, creates a disk, or starts a door or a clock; those need the person.
