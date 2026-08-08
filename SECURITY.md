# Security Policy

## Scope

buzz-agent-prime runs Prime Agent and its subagents with the permissions of
the container user. It is **not a security sandbox**: subagents execute code
with the same privileges as the process. Deployments must treat the agent
identity, its Nostr key, and its state volume as sensitive.

## Reporting

Report vulnerabilities privately to the maintainer. Do not open public issues
for active exploits. Include the affected version, upstream pin, and a minimal
reproduction.

## Deployment expectations

- Run the published container images with a non-root user and read-only root
  filesystem (see `deploy/`).
- Keep `BUZZ_PRIVATE_KEY` and model credentials out of manifests and
  repository files; use secrets management (e.g. Warden/ExternalSecret on
  Kubernetes).
- Do not grant the agent cluster-admin or broad Kubernetes API permissions.
- Back up the state volume (`/var/lib/buzz-agent-prime`) to protect session
  and kernel state.

## Known boundaries (v0.1)

- No multi-tenant isolation between channels: sessions share the container
  user's privileges.
- No remote/container-per-subagent execution (non-goal).
