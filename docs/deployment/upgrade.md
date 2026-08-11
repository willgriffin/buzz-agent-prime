# Upgrade and Rollback

This guide covers safe upgrade and rollback procedures for `buzz-agent-prime`
deployments. Upgrades move the container image to a new tagged release;
rollbacks revert to a previous known-good image.

## Before you upgrade

1. **Review the release notes** for the target version. Check
   [compatibility.md](../compatibility.md) for upstream pin changes.
2. **Back up the state volume.** See [Backup and Restore](backup.md).
3. **Verify the current version:**

```bash
# Docker
docker exec buzz-agent-prime buzz-agent-prime version

# Kubernetes
kubectl exec -n buzz-agents statefulset/buzz-agent-prime -- buzz-agent-prime version
```

4. **Check for breaking changes.** Contract changes (commands, environment
   variables, exit codes) require a minor-version bump and a documented
   migration path — see [contracts.md](../contracts.md).

## Docker upgrade

### 1. Pull the new image

```bash
docker compose --file deploy/docker/docker-compose.yml pull
```

Or, if building from source:

```bash
git fetch --tags
git checkout v0.1.1  # target release tag
```

### 2. Recreate the container

```bash
docker compose --file deploy/docker/docker-compose.yml up -d
```

Compose detects the new image and recreates the container. The named state
volume persists — named-channel sessions resume automatically.

### 3. Verify

```bash
# Confirm the new version
docker exec buzz-agent-prime buzz-agent-prime version

# Run diagnostics
docker exec buzz-agent-prime buzz-agent-prime doctor

# Check logs for errors
docker logs buzz-agent-prime 2>&1 | tail -30
```

## Docker rollback

### 1. Set the previous image tag

Edit `deploy/docker/docker-compose.yml` to revert the image tag:

```yaml
services:
  buzz-agent-prime:
    image: ghcr.io/willgriffin/buzz-agent-prime:0.1.0 # previous version
```

### 2. Recreate the container

```bash
docker compose --file deploy/docker/docker-compose.yml up -d
```

### 3. Verify

```bash
docker exec buzz-agent-prime buzz-agent-prime version
docker exec buzz-agent-prime buzz-agent-prime doctor
```

### State downgrades

Rolling back the image does **not** roll back the state volume. If a newer
version wrote state that is incompatible with the older version:

1. Stop the agent: `docker compose --file deploy/docker/docker-compose.yml down`
2. Restore the state volume from the pre-upgrade backup. See
   [Backup and Restore](backup.md).
3. Restart with the old image.

## Kubernetes upgrade

### Rolling update (brief downtime for single replica)

Kubernetes StatefulSets perform rolling updates when the image changes. Since
v0.1 runs a single replica, the update terminates the old pod and starts a
new one — there is a brief downtime.

```bash
# Set both pod containers to the new image tag
kubectl set image statefulset/buzz-agent-prime \
  agent=ghcr.io/willgriffin/buzz-agent-prime:0.1.1 \
  initialize-workspace=ghcr.io/willgriffin/buzz-agent-prime:0.1.1 \
  -n buzz-agents

# Watch the rollout
kubectl rollout status statefulset/buzz-agent-prime -n buzz-agents
```

The `agent` and `initialize-workspace` containers intentionally reuse the same
image. Update both in one command so workspace initialization and the running
agent always come from the same release.

The PVC persists across the rollout. Named-channel sessions resume
automatically on the new pod.

### 3. Verify

```bash
# Confirm the new version
kubectl exec -n buzz-agents statefulset/buzz-agent-prime -- buzz-agent-prime version

# Run diagnostics
kubectl exec -n buzz-agents statefulset/buzz-agent-prime -- buzz-agent-prime doctor

# Check pod status and logs
kubectl get pods -n buzz-agents
kubectl logs -n buzz-agents statefulset/buzz-agent-prime --tail=30
```

## Kubernetes rollback

### Using `kubectl rollout undo`

If the updated pod fails to start or pass health checks:

```bash
# Immediately roll back to the previous revision
kubectl rollout undo statefulset/buzz-agent-prime -n buzz-agents

# Watch the rollback
kubectl rollout status statefulset/buzz-agent-prime -n buzz-agents
```

### Pinning a specific image

For explicit control, set the image tag back to the known-good version:

```bash
kubectl set image statefulset/buzz-agent-prime \
  agent=ghcr.io/willgriffin/buzz-agent-prime:0.1.0 \
  initialize-workspace=ghcr.io/willgriffin/buzz-agent-prime:0.1.0 \
  -n buzz-agents
```

### State downgrades

Kubernetes rollbacks revert the image but **not** the PVC. If the newer
version wrote incompatible state:

1. Scale down: `kubectl scale statefulset/buzz-agent-prime -n buzz-agents --replicas=0`
2. Restore the PVC from the pre-upgrade snapshot or backup. See
   [Backup and Restore](backup.md).
3. Scale back up: `kubectl scale statefulset buzz-agent-prime -n buzz-agents --replicas=1`

## Upgrade compatibility matrix

When upgrading, check whether upstream pins changed. See
[compatibility.md](../compatibility.md) for the full matrix.

| Upgrade path  | Pin changes?     | Action needed                           |
| ------------- | ---------------- | --------------------------------------- |
| 0.1.0 → 0.1.1 | Possible (patch) | Review release notes; back up first.    |
| 0.1.x → 0.2.0 | Likely (minor)   | Follow documented migration path.       |
| 0.x → 1.0.0   | Expected (major) | Full migration guide + state migration. |

Contract-breaking changes always bump the minor version (v0.x → v0.x+1) and
include a documented migration path.

## Post-upgrade checklist

- [ ] `buzz-agent-prime version` shows the expected version.
- [ ] `buzz-agent-prime doctor` passes with no errors.
- [ ] Pod/container is healthy (running, no CrashLoopBackOff).
- [ ] Relay connection is established (check logs).
- [ ] Test message from a Buzz channel gets a response.
- [ ] Named-channel sessions recall prior context.
- [ ] `BUZZ_ACP_RESPOND_TO` still gates correctly.
