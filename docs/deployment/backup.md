# Backup and Restore

Persistent runtime storage differs slightly by target. Docker and Compose use
two named volumes: `buzz-agent-prime-state` at `/var/lib/buzz-agent-prime` and
`buzz-agent-prime-workspace` at `/workspace`. Kubernetes stores both on the
StatefulSet PVC, mounting the PVC's `workspace` subpath at `/workspace`. This
guide covers consistent backup and restore procedures for both layouts.

## What is in the state directory

```text
/var/lib/buzz-agent-prime/
  tmp/             # Writable scratch space (not critical for backups)
  sessions/        # Named-channel session state and kernel checkpoints
  artifacts/       # Generated files and outputs
  repos/           # Git checkouts managed by sessions

/workspace/        # Repository checkouts and working-tree changes
```

### What to back up

| Path         | Critical? | Notes                                                |
| ------------ | --------- | ---------------------------------------------------- |
| `sessions/`  | **Yes**   | Named-channel checkpoints; required to resume.       |
| `repos/`     | **Yes**   | Local clones with work-in-progress; slow to rebuild. |
| `artifacts/` | Optional  | Regeneratable, but may hold valuable outputs.        |
| `/workspace` | **Yes**   | Repository checkouts and in-progress working trees.  |
| `tmp/`       | No        | Scratch space; safe to exclude from backups.         |

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

# Archive both persistent volumes from the same stopped point in time.
docker run --rm \
  -v buzz-agent-prime-state:/state:ro \
  -v buzz-agent-prime-workspace:/workspace:ro \
  -v "$(pwd)/backup":/backup \
  alpine sh -ec 'tar czf /backup/buzz-agent-prime-state-$(date +%Y%m%d).tar.gz -C /state .
                 tar czf /backup/buzz-agent-prime-workspace-$(date +%Y%m%d).tar.gz -C /workspace .'

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
restic -r /backup/buzz-agent-prime backup --tag docker-state \
  /var/lib/docker/volumes/buzz-agent-prime-state/_data
restic -r /backup/buzz-agent-prime backup --tag docker-workspace \
  /var/lib/docker/volumes/buzz-agent-prime-workspace/_data
```

## Docker restore

```bash
# Stop the agent
docker compose --file deploy/docker/docker-compose.yml down

# Remove the existing volumes (WARNING: destroys current state and checkouts)
docker volume rm buzz-agent-prime-state buzz-agent-prime-workspace

# Create fresh volumes and restore both archives from the same backup point.
docker volume create buzz-agent-prime-state
docker volume create buzz-agent-prime-workspace
docker run --rm \
  -v buzz-agent-prime-state:/state \
  -v buzz-agent-prime-workspace:/workspace \
  -v "$(pwd)/backup":/backup \
  alpine sh -ec 'tar xzf /backup/buzz-agent-prime-state-20250108.tar.gz -C /state
                 tar xzf /backup/buzz-agent-prime-workspace-20250108.tar.gz -C /workspace'

# Restart
docker compose --file deploy/docker/docker-compose.yml up -d
```

## Kubernetes backup

### Option A: `kubectl cp` (ad hoc)

```bash
# Scale down the StatefulSet so state and its workspace subpath are consistent.
kubectl scale statefulset buzz-agent-prime -n buzz-agents --replicas=0
# Wait for the ordinal pod to release the ReadWriteOnce PVC before mounting it.
kubectl wait -n buzz-agents --for=delete pod/buzz-agent-prime-0 --timeout=60s

# Run a temporary helper against the StatefulSet PVC and copy the complete
# state directory. It includes `workspace`, which backs `/workspace`.
kubectl run -n buzz-agents backup-helper --restart=Never --image=alpine \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "backup-helper",
        "image": "alpine",
        "command": ["sleep", "3600"],
        "volumeMounts": [{"name": "state", "mountPath": "/state", "readOnly": true}]
      }],
      "volumes": [{
        "name": "state",
        "persistentVolumeClaim": {"claimName": "buzz-agent-prime-state-buzz-agent-prime-0"}
      }]
    }
  }'
kubectl wait -n buzz-agents --for=condition=Ready pod/backup-helper --timeout=60s
kubectl cp -n buzz-agents backup-helper:/state ./backup/buzz-agent-prime-state-$(date +%Y%m%d)

# Scale back up
kubectl delete pod -n buzz-agents backup-helper --ignore-not-found
kubectl scale statefulset buzz-agent-prime -n buzz-agents --replicas=1
```

### Option B: Volume snapshots

If your StorageClass supports volume snapshots
(`VolumeSnapshotClass`):

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: buzz-agent-prime-state-snapshot-20250108
  namespace: buzz-agents
spec:
  volumeSnapshotClassName: csi-snapshot-class
  source:
    persistentVolumeClaimName: buzz-agent-prime-state-buzz-agent-prime-0
```

```bash
kubectl apply -f snapshot.yaml

# Check status
kubectl get volumesnapshot -n buzz-agents
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
  namespace: buzz-agents
spec:
  schedule: "0 2 * * *" # Daily at 2 AM
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
                claimName: buzz-agent-prime-state-buzz-agent-prime-0
```

## Kubernetes restore

The StatefulSet claim-template name is immutable. Restore the contents into
the original ordinal PVC (`buzz-agent-prime-state-buzz-agent-prime-0` for the
base) while the StatefulSet is scaled down; do not patch the template name.
Restore the complete PVC, including its `workspace` directory, from the same
snapshot or archive used for the backup.

If a storage system requires a new PVC for snapshot restore, treat the switch
as a deliberate StatefulSet migration in a cluster-specific change. Do not
make that migration in the reusable base manifest: it must preserve the
existing PVC identity and verify both `/var/lib/buzz-agent-prime` and
`/workspace` before the workload is scaled back up.

## Backup verification

After restoring, always verify state and the workspace checkout are intact:

```bash
# Docker
docker exec -it buzz-agent-prime buzz-agent-prime doctor
docker logs buzz-agent-prime 2>&1 | head -20

# Kubernetes (the example overlay shown here)
kubectl exec -n buzz-agents statefulset/buzz-agent-prime-example -- buzz-agent-prime doctor
kubectl logs -n buzz-agents statefulset/buzz-agent-prime-example --tail=20
```

Then send a message to a previously-persisted named channel and verify that a
repository checkout under `/workspace` still has its expected working-tree
contents.
