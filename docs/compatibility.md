# Upstream Pins and Compatibility Policy

Every release of buzz-agent-prime is built from **immutable upstream pins** so
that image contents and behaviour reproduce exactly. Pins are reviewed and
advanced deliberately, never on `latest`.

## Pinned revisions (v0.1)

| Component                                   | Source                                                  | Pin                                                   | Notes                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| prime-agent                                 | `PrimeIntellect-ai/prime-agent` (packages/coding-agent) | `v0.7.1` / `a18809e00ea30638584d87b3afea7285a9d7296c` | npm package `prime-agent` is **not on the public registry**; consume from the pinned GitHub commit tarball. |
| buzz (incl. buzz-acp, git-credential-nostr) | `block/buzz`                                            | `3a96acea09b4a9e3f02c3a26cfb0607d2ccacf42`            | Release `Buzz Desktop 0.5.3`. `buzz-acp` and `git-credential-nostr` are built from this commit's crates.    |
| Node.js                                     | —                                                       | `22`                                                  | LTS line; exact digest pinned in the container build (issue #5).                                            |
| Python                                      | —                                                       | `3.12`                                                | Runtime for Prime's IPython kernel; exact digest pinned in the container build (issue #5).                  |

## Compatibility policy

- **Pinned-and-tested**: the matrix below is exercised by the contract and
  e2e suites (issue #8) before every release.
- **Next-candidate**: a single candidate revision may be tracked for
  forward-compatibility signals, but never shipped unless it passes the same
  suites and the pin is advanced in this document.
- **Breaking upstream change**: the pin is held, the break is characterised,
  and the fix lands before any bump.

## Compatibility matrix (v0.1)

| prime-agent          | buzz-acp (block/buzz) | Status         |
| -------------------- | --------------------- | -------------- |
| v0.7.1 (`a18809e0`)  | `3a96acea` (0.5.3)    | Pinned target  |
| next candidate (TBD) | `3a96acea` (0.5.3)    | Next-candidate |
| v0.7.1 (`a18809e0`)  | next candidate (TBD)  | Next-candidate |

Renovate rules (issue #9) advance candidates only; the pinned target advances
only after green CI and a review in this document.
