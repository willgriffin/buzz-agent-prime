# Kubernetes Deployment

This guide deploys `buzz-agent-prime` as a single-replica StatefulSet on
Kubernetes. It is designed for operators who need persistent state, rolling
updates, and integration with cluster secrets management.

## Prerequisites

- **Kubernetes 1.28+** cluster with `kubectl` configured.
- A **Buzz Nostr identity** (nsec or hex). See [Identity Setup](identity.md).
- One or more **model provider API keys**. See [Provider Configuration](providers.md).
- A **StorageClass** with persistent volume support (for state).
- A reachable **Buzz relay** (default: `wss://buzz.happyvertical.com`).

## Architecture: single-replica StatefulSet

`buzz-agent-prime` v0.1 is designed for **single-replica deployments only**.
The multiplexer cannot coordinate between multiple replicas, and the state
directory is not shared. Kubernetes manifests use a `StatefulSet` with
`replicas: 1` to ensure:

- A stable pod identity and persistent volume.
- No concurrent replicas running against the same state.
- Ordered startup and shutdown.

Do not scale `replicas` above 1 in v0.1.

## Quick start

### 1. Create secrets

```bash
kubectl create secret generic buzz-agent-secrets \
  --from-literal=BUZZ_PRIVATE_KEY=nsec1yourkeyhere… \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-api03-…
```

For production, use
[ExternalSecrets](https://external-secrets.io/) or
[Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets) — see
[Provider Configuration](providers.md).

### 2. Apply manifests

The manifests live under `deploy/kubernetes/` (maintained by the Kubernetes
worker, issue #7):

```bash
# Kustomize
kubectl apply -k deploy/kubernetes/

# Or apply individual manifests:
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl apply -f deploy/kubernetes/secret.yaml
kubectl apply -f deploy/kubernetes/configmap.yaml
kubectl apply -f deploy/kubernetes/statefulset.yaml
kubectl apply -f deploy/kubernetes/service.yaml
```

### 3. Verify

```bash
# Check pod status
kubectl get pods -n buzz-agent-prime

# Run diagnostics
kubectl exec -n buzz-agent-prime deployment/buzz-agent-prime -- buzz-agent-prime doctor

# Check logs
kubectl logs -n buzz-agent-prime deployment/buzz-agent-prime --tail=30

# Check the persistent volume
kubectl get pvc -n buzz-agent-prime
```

## Expected manifest structure

> The actual manifest files are maintained by the Kubernetes worker (issue
> #7). This section documents the expected structure so operators know what to
> look for and how to customize.

### StatefulSet

```yaml
# Structurally similar to deploy/kubernetes/statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: buzz-agent-prime
  namespace: buzz-agent-prime
spec:
  replicas: 1 # Do not scale above 1 in v0.1
  serviceName: buzz-agent-prime
  selector:
    matchLabels:
      app: buzz-agent-prime
  template:
    metadata:
      labels:
        app: buzz-agent-prime
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: buzz-agent-prime
          image: ghcr.io/willgriffin/buzz-agent-prime:0.1.0
          ports:
            - containerPort: 3000
              name: http
          envFrom:
            - configMapRef:
                name: buzz-agent-config
          env:
            - name: BUZZ_PRIVATE_KEY
              valueFrom:
                secretKeyRef:
                  name: buzz-agent-secrets
                  key: BUZZ_PRIVATE_KEY
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: buzz-agent-secrets
                  key: ANTHROPIC_API_KEY
          volumeMounts:
            - name: state
              mountPath: /var/lib/buzz-agent-prime
            - name: tmp
              mountPath: /tmp
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
          readinessProbe:
            exec:
              command: ["buzz-agent-prime", "doctor"]
            initialDelaySeconds: 10
            periodSeconds: 30
          livenessProbe:
            exec:
              command: ["buzz-agent-prime", "doctor"]
            initialDelaySeconds: 30
            periodSeconds: 60
  volumeClaimTemplates:
    - metadata:
        name: state
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10Gi
```

### PersistentVolumeClaim

State is backed by a `volumeClaimTemplate` in the StatefulSet. The PVC is
named `<statefulset-name>-state-<ordinal>` (e.g.
`buzz-agent-prime-state-0`) and persists across pod restarts and image
updates.

## Configuration

All configuration is environment-based — see
[contracts](../contracts.md) for the full list.

### ConfigMap

Non-secret configuration goes in a `ConfigMap`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: buzz-agent-config
  namespace: buzz-agent-prime
data:
  BUZZ_RELAY_URL: "wss://buzz.happyvertical.com"
  BUZZ_ACP_RESPOND_TO: "owner-only"
  BUZZ_AGENT_PRIME_MAX_SESSIONS: "4"
  BUZZ_AGENT_PRIME_STATE_DIR: "/var/lib/buzz-agent-prime"
```

### Secrets

Secret values (`BUZZ_PRIVATE_KEY`, API keys) go in `Secret` resources and
are referenced via `secretKeyRef`. Never put secret values in a `ConfigMap`.

## PVC backup and restore

The PVC at `/var/lib/buzz-agent-prime` holds named-channel session state,
kernel checkpoints, artifacts, and repository checkouts. Back it up
regularly. See [Backup and Restore](backup.md) for procedures using
`kubectl cp`, volume snapshots, and restic.

## Rolling updates

Kubernetes StatefulSets support rolling updates by default. When you change
the image tag, Kubernetes updates the single pod after the new image is pulled:

```bash
kubectl set image statefulset/buzz-agent-prime \
  buzz-agent-prime=ghcr.io/willgriffin/buzz-agent-prime:0.1.1 \
  -n buzz-agent-prime
```

The PVC persists across the update. Named-channel sessions resume on the new
image.

See [Upgrade and Rollback](upgrade.md) for safe upgrade and rollback
procedures.

## Security hardening

**The agent and its subagents execute with the container user's permissions.
`buzz-agent-prime` is not a security sandbox.**

Apply these security contexts:

| Setting                    | Value     | Purpose                      |
| -------------------------- | --------- | ---------------------------- |
| `runAsNonRoot`             | `true`    | Disallow running as root.    |
| `runAsUser`                | `1000`    | Non-root UID.                |
| `fsGroup`                  | `1000`    | Volume ownership.            |
| `readOnlyRootFilesystem`   | `true`    | Immutability of rootfs.      |
| `allowPrivilegeEscalation` | `false`   | No `setuid` escalation.      |
| `capabilities.drop`        | `["ALL"]` | Drop all Linux capabilities. |

Additional recommendations:

- Do not grant the service account `cluster-admin` or broad RBAC
  permissions. The agent does not need to access the Kubernetes API in v0.1.
- Use a dedicated namespace (`buzz-agent-prime`) to limit blast radius.
- Set resource requests and limits:

```yaml
resources:
  requests:
    cpu: "500m"
    memory: 1Gi
  limits:
    cpu: "2"
    memory: 4Gi
```

## Scaling

v0.1 does not support horizontal scaling. Ensure `replicas: 1`. The
multiplexer's session routing and state directory are inherently single-node.

Scaling to multiple replicas would cause:

- Duplicate relay connections under the same identity.
- Conflicting session routing.
- State directory races on a shared volume.

Multi-replica support is a non-goal for v0.1.
