# Third-Party Notices

buzz-agent-prime is distributed under the MIT License (see `LICENSE`).

The distribution bundles or depends on third-party software. Required notices
are collected here and in the release SBOM. Full text of each dependency
license is retained under `third-party/` when a package is vendored; for
package-managed dependencies the license is declared in the package metadata
and mirrored in the SBOM at release time.

## Directly bundled components (pinned)

| Component            | Upstream                                                                 | Pin                  | License      |
| -------------------- | ------------------------------------------------------------------------ | -------------------- | ------------ |
| prime-agent          | https://github.com/PrimeIntellect-ai/prime-agent (packages/coding-agent) | v0.7.1 / `a18809e0…` | See upstream |
| buzz-acp             | https://github.com/block/buzz (crates/buzz-acp)                          | `3a96acea…`          | See upstream |
| git-credential-nostr | https://github.com/block/buzz (crates/git-credential-nostr)              | `3a96acea…`          | See upstream |

Third-party notices are regenerated as part of the release pipeline (issue #9).
