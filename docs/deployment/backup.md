# Backup and Restore

The state directory (`/var/lib/buzz-agent-prime`, configured via
`BUZZ_AGENT_PRIME_STATE_DIR`) holds all persistent runtime state. This guide
covers backup and restore procedures for Docker and Kubernetes.

## What is in the state directory

```text
/var/lib/buzz-agent-prime/
  workspace/       # Default working directory for sessions
  tmp/             # Writable scratch space (not critical for backups)
  sessions/        # Named-channel session state and kernel checkpoints
  artifacts/       # Generated files and outputs
  repos/           # Git checkouts managed by sessions
```

### What to back up

| Path        | Critical? | Notes                                              |
| ----------- | --------- | -------------------------------------------------- |
| `sessions/` | **Yes**   | Named-channel checkpoints; required to resume.     |
| `repos/`    | **Yes**   | Local clones with work-in-progress; slow to rebuild.|
| `artifacts/`| Optional  | Regeneratable, but may hold valuable outputs.     |
| `workspace/`| Optional  | Working files; sessions can recreate as needed.    |
| `tmp/`      | No        | Scratch space; safe to exclude from backups.        |

### Named-channel vs. ephemeral sessions

- **Named-channel sessions** (those with `_meta.sessionTitle`) have their
  state persisted under `sessions/<title>/`. These survive restarts and must
  be backed up to preserve conversation continuity.
- **Ephemeral sessions** (no `_meta.sessionTitle`) are not persisted — they
  always start fresh after a restart. There is nothing to back up for these.

## Docker backup

### Option A: `docker cp` (ad hoc)

```bash
# Stop the agent to ensure consistent state
docker compose --file deploy/docker/docker-compose.yml down

# Copy the state directory out of the volume
docker run --rm \
  -v buzz-agent-prime-state:/state \
  -v "$(pwd)/backup":/backup \
  alpine tar czf /backup/buzz-agent-prime-state-$(date +%Y%m%d).tar.gz \
  -C /state .

# Restart the agent
docker compose --file deploy/docker/docker-compose.yml up -d
```

### Option B: Volume snapshots (storage driver)

If your Docker storage driver supports snapshots (e.g. ZFS, BTRFS), use it
for point-in-time consistency without stopping the container:

```bash
# ZFS example
zfs snapshot tank/docker/buzz-agent-prime-state@$(date +%Y%m%d)
```

### Option C: `restic` (recommended for automated backups)

```bash
restic -r /backup/buzz-agent-prime backup \
  --tag docker \
  /var/lib/docker/volumes/buzz-agent-prime-state/_data
```

## Docker restore

```bash
# Stop the agent
docker compose --file deploy/docker/docker-compose.yml down

# Remove the existing volume (WARNING: destroys current state)
docker volume rm buzz-agent-prime-state

# Create a fresh volume and restore into it
docker volume create buzz-agent-prime-state
docker run --rm \
  -v buzz-agent-prime-state:/state \
  -v "$(pwd)/backup":/backup \
  alpine tar xzf /backup/buzz-agent-prime-state-20250108.tar.gz -C /state

# Restart
docker compose --file deploy/docker/docker-compose.yml up -d
```

## Kubernetes backup

### Option A: `kubectl cp` (ad hoc)

```bash
# Scale down the StatefulSet
kubectl scale statefulset buzz-agent-prime -n buzz-agent-prime --replicas=0

# Wait for the pod to terminate
kubectl wait --for=delete pod -l app=buzz-agent-prime -n buzz-agent-prime --timeout=60s

# Copy state out of the PVC
kubectl run -n buzz-agent-prime backup-helper --rm -i \
  --image=alpine --restart=Never \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "backup-helper",
        "image": "alpine",
        "command": ["tar", "czf", "/backup/state.tar.gz", "-C", "/state", "."],
        "volumeMounts": [{
          "name": "state",
          "mountPath": "/state"
        }]
      }],
      "volumes": [{
        "name": "state",
        "persistentVolumeClaim": {
          "claimName": "buzz-agent-prime-state-0"
        }
      }]
    }
  }' \
  --restart=Never

# Scale back up
kubectl scale statefulset buzz-agent-prime -n buzz-agent-prime --replicas=1
```

### Option B: Volume snapshots

If your StorageClass supports volume snapshots
(`VolumeSnapshotClass`):

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: buzz-agent-prime-state-snapshot-20250108
  namespace: buzz-agent-prime
spec:
  volumeSnapshotClassName: csi-snapshot-class
  source:
    persistentVolumeClaimName: buzz-agent-prime-state-0
```

```bash
kubectl apply -f snapshot.yaml

# Check status
kubectl get volumesnapshot -n buzz-agent-prime
```

### Option C: Restic via CronJob

For automated, scheduled backups with retention policies, run
[restic](https://restic.net/) in a Kubernetes `CronJob` that mounts the PVC
and pushes to S3/GCS/B2:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: buzz-agent-prime-backup
  namespace: buzz-agent-prime
spec:
  schedule: "0 2 * * *"      # Daily at 2 AM
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: restic
              image: restic/restic:latest
              envFrom:
                - secretRef:
                    name: restic-repo-secrets
              volumeMounts:
                - name: state
                  mountPath: /state
                  readOnly: true
              command:
                - restic
                - -r
                - s3:https://minio.example.com/buzz-agent-prime
                - backup
                - /state
          volumes:
            - name: state
              persistentVolumeClaim:
                claimName: buzz-agent-prime-state-0
```

## Kubernetes restore

### From a volume snapshot

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: buzz-agent-prime-state-restored
  namespace: buzz-agent-prime
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 10Gi
  dataSource:
    name: buzz-agent-prime-state-snapshot-20250108
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
```

```bash
# Scale down
kubectl scale statefulset buzz-agent-prime -n buzz-agent-prime --replicas=0

# Create the restored PVC
kubectl apply -f restored-pvc.yaml

# Update the StatefulSet to use the restored PVC (or swap via patch)
kubectl patch statefulset buzz-agent-prime -n buzz-agent-prime \
  --type=json -p='[{"op":"replace","path":"/spec/volumeClaimTemplates/0/metadata/name","value":"state-restored"}]'

# Scale back up
kubectl scale statefulset buzz-agent-prime -n buzz-agent-prime --replicas=1
```

### From a restic backup

```bash
# Scale down
kubectl scale statefulset buzz-agent-prime -n buzz-agent-prime --replicas=0

# Run a restore pod
kubectl run -n buzz-agent-prime restic-restore --rm -i \
  --image=restic/restic:latest --restart=Never \
  --overrides='{... volumeMounts, restic restore command ...}' \
  -- restic -r s3:... restore latest --target /state

# Scale back up
kubectl scale statefulset buzz-agent-prime -n buzz-agent-prime --replicas=1
```

## Backup verification

After restoring, always verify the state is intact:

```bash
# Docker
docker exec -it buzz-agent-prime buzz-agent-prime doctor
docker logs buzz-agent-prime 2>&1 | head -20

# Kubernetes
kubectl exec -n buzz-agent-prime deployment/buzz-agent-prime -- buzz-agent-prime doctor
kubectl logs -n buzz-agent-prime deployment/buzz-agent-prime --tail=20
```

Then send a message to a previously-persisted named channel and confirm the
agent recalls prior session context.
