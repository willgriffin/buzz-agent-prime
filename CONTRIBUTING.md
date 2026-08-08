# Contributing to buzz-agent-prime

## Tracking and provenance

- **Buzz is canonical.** Issues, status, and review live on the Buzz relay
  (`buzz.happyvertical.com`); GitHub is the public mirror and issue tracker.
- Implementation issues are claimed on the tracker before work begins.

## Development setup

Requires Node.js 22 and npm 10 (see `.nvmrc`/`engines`).

```bash
npm ci            # install from the lockfile
npm run typecheck # TypeScript type check
npm run lint      # ESLint
npm run format    # Prettier (write)
npm run test      # Vitest
npm run build     # tsc -> dist/
```

## Conventions

- TypeScript, strict mode, ESM (`"type": "module"`), NodeNext resolution.
- Formatting: Prettier (see `.prettierrc.json`).
- Tests live beside the code or under `test/`; contract/e2e suites live under
  `test/contract/` and `test/e2e/` (issue #8) with their own conventions.
- Commands, env vars, and exit codes are public contracts
  (`docs/contracts.md`). Changing them requires updating that document.
- Never print secrets; never commit credentials, tokens, or private keys.

## Directory ownership

See `docs/directories.md`. Parallel workers own disjoint directories; a
pull request must not touch paths owned by another worker.

## Developer Certificate of Origin

All contributions must include the `Signed-off-by:` trailer:

> Developer Certificate of Origin
> Version 1.1
>
> Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
>
> Everyone is permitted to copy and distribute verbatim copies of this
> license document, but changing it is not allowed.
>
> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I have the
> right to submit it under the open source license indicated in the file;
> or
>
> (b) The contribution is based upon previous work that, to the best of my
> knowledge, is covered under an appropriate open source license and I
> have the right under that license to submit that work with
> modifications, whether created in whole or in part by me, under the same
> open source license (unless I am permitted to submit under a different
> license, as indicated in the file); or
>
> (c) The contribution was provided to me by some other person who certified
> (a) or (b) and I have not modified it.
>
> (d) I understand and agree that this project and the contribution are
> public and that a record of the contribution (including all personal
> information I submit with it, including my sign-off) is maintained
> indefinitely and may be redistributed consistent with this project or
> the open source license(s) involved.

```text
Signed-off-by: Will Griffin <will@griffn.ca>
```

## Pull requests

- One issue per PR; reference the tracker issue.
- PRs must pass typecheck, lint, format check, tests, and build.
- The `master` branch is protected; merges go through review.
