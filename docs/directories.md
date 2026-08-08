# Directory Ownership

Parallel workers must never own the same directory. This table is the
authority for ownership; a worker's scope is the union of its directories and
the root files they own. Files not listed (e.g. `package.json`, `tsconfig.json`,
`src/app.ts`, `src/cli.ts`) are owned by the foundation (#2) and the lead, and
may be touched only via review.

| Path                                                                                                                                                                                                                 | Owner                | Issue |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----- |
| `src/acp/**`                                                                                                                                                                                                         | Core worker          | #3    |
| `src/serve/**`                                                                                                                                                                                                       | Runtime worker       | #4    |
| `src/state/**`                                                                                                                                                                                                       | Runtime worker       | #4    |
| `container/**`                                                                                                                                                                                                       | Container worker     | #5    |
| `deploy/docker/**`                                                                                                                                                                                                   | Docker worker        | #6    |
| `deploy/kubernetes/**`                                                                                                                                                                                               | Kubernetes worker    | #7    |
| `test/contract/**`                                                                                                                                                                                                   | QA worker            | #8    |
| `test/e2e/**`                                                                                                                                                                                                        | QA worker            | #8    |
| `docs/**` (except `contracts.md`, `compatibility.md`, `directories.md`)                                                                                                                                              | Documentation worker | #10   |
| `scripts/release/**`, `.github/workflows/release*.yml`                                                                                                                                                               | Release worker       | #9    |
| root files (`package.json`, `tsconfig.json`, `LICENSE`, `NOTICE.md`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/contracts.md`, `docs/compatibility.md`, `docs/directories.md`, `.github/workflows/ci.yml`) | Foundation / lead    | #2    |

## Rules

1. Two workers never write the same path.
2. A worker may read anything, but writes only within its owned paths.
3. Contract changes (`docs/contracts.md`) are review-only for workers: propose,
   do not edit.
4. `src/app.ts` is the only file allowed to import across worker boundaries
   until integration (issue #8).
