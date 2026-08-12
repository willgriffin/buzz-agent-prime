# Kubernetes Deployment

`buzz-agent-prime` runs as a one-replica StatefulSet in the `buzz-agents`
namespace. Its `buzz-agent-prime-state` volume claim template provides the
persistent state needed to recover named Prime sessions after a pod
replacement. The same PVC provides `/workspace` through its `workspace`
subpath, so repository checkouts and uncommitted working-tree changes survive
replacement too. Do not scale this deployment above one replica in v0.1.

## Prerequisites

- Kubernetes 1.28+ and `kubectl` with access to the target cluster.
- A default StorageClass (or an overlay that supplies one) supporting
  `ReadWriteOnce` PVCs.
- A Buzz Nostr private key and at least one model-provider API key. See
  [Identity Setup](identity.md) and [Provider Configuration](providers.md).

The manifests create no credentials and request no Kubernetes RBAC. The pod
runs non-root with a read-only root filesystem, no privilege escalation, all
Linux capabilities dropped, a RuntimeDefault seccomp profile, resource
requests/limits, and a 30-second termination grace period.

## Render the manifests

Always render before applying. Both the reusable base and the sample overlay
must render successfully:

```bash
kubectl kustomize deploy/kubernetes/base
kubectl kustomize deploy/kubernetes/overlays/example
```

The example overlay adds an `-example` suffix to the StatefulSet, Service, and
NetworkPolicy, while retaining the externally provisioned
`buzz-agent-prime-secrets` reference. It deliberately contains no Secret or
secret generator.

## Create the external Secret

Create the exact stable Secret name before applying either kustomization. Do
not commit the command with real values or create an empty Secret in the base.
The base owns the namespace; apply it first so fresh clusters can create the
Secret idempotently:

```bash
kubectl apply -f deploy/kubernetes/base/namespace.yaml
kubectl -n buzz-agents create secret generic buzz-agent-prime-secrets \
  --from-literal=BUZZ_PRIVATE_KEY='nsec1replace-with-your-key' \
  --from-literal=ANTHROPIC_API_KEY='replace-with-your-provider-key'
```

Use `OPENAI_API_KEY` or another supported provider key in place of
`ANTHROPIC_API_KEY` when appropriate. The StatefulSet imports the Secret with
`envFrom`; its name does not receive a Kustomize hash.

For production, provision that same Secret name with your secrets manager.
For example, an External Secrets Operator resource can target the required
name without placing credentials in Git:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: buzz-agent-prime-secrets
  namespace: buzz-agents
spec:
  secretStoreRef:
    name: production-secrets
    kind: ClusterSecretStore
  target:
    name: buzz-agent-prime-secrets
    creationPolicy: Owner
  data:
    - secretKey: BUZZ_PRIVATE_KEY
      remoteRef:
        key: buzz-agent-prime/private-key
    - secretKey: ANTHROPIC_API_KEY
      remoteRef:
        key: buzz-agent-prime/anthropic-api-key
```

Before applying the workload, verify that the Secret controller has created
the target Secret:

```bash
kubectl -n buzz-agents get secret buzz-agent-prime-secrets
```

## Apply and verify

Choose one target. The example is useful for a non-production installation;
the base keeps the canonical `buzz-agent-prime` resource names.

```bash
kubectl apply -k deploy/kubernetes/overlays/example
kubectl -n buzz-agents rollout status statefulset/buzz-agent-prime-example
kubectl -n buzz-agents exec statefulset/buzz-agent-prime-example -- \
  buzz-agent-prime doctor
```

The external Secret must contain `BUZZ_PRIVATE_KEY`; `doctor` checks that
configuration without printing secret values. Inspect the workload and storage
without exposing credentials:

```bash
kubectl -n buzz-agents get statefulset,pod,pvc
kubectl -n buzz-agents describe pod buzz-agent-prime-example-0
```

The rendered template mounts `buzz-agent-prime-state` directly at the state
directory and mounts its pre-created `workspace` subpath at `/workspace`. A
non-root init container creates that subpath before the application starts;
this is required because Kubernetes does not create missing subpaths. The
ordinal pod receives the StatefulSet-generated PVC
`buzz-agent-prime-state-buzz-agent-prime-example-0` (the base uses
`buzz-agent-prime-state-buzz-agent-prime-0`). This preserves the established
PVC identity on an ordinary pod-template rollout; no StatefulSet recreation or
data migration is required.

## Pod-replacement/PVC identity evidence

The manifest test checks the deterministic relationship between the
`buzz-agent-prime-state` mount, the matching claim template, and the resulting
ordinal PVC name. A live cluster recovery test remains gated by issue #11.
When that environment is available, collect this evidence after creating a
named Prime session:

```bash
kubectl -n buzz-agents get pod buzz-agent-prime-example-0 \
  -o jsonpath='{.spec.volumes[?(@.name=="buzz-agent-prime-state")].persistentVolumeClaim.claimName}{"\\n"}'
kubectl -n buzz-agents get pvc buzz-agent-prime-state-buzz-agent-prime-example-0 \
  -o jsonpath='{.metadata.uid}{"\\n"}'
kubectl -n buzz-agents delete pod buzz-agent-prime-example-0
kubectl -n buzz-agents rollout status statefulset/buzz-agent-prime-example
kubectl -n buzz-agents get pvc buzz-agent-prime-state-buzz-agent-prime-example-0 \
  -o jsonpath='{.metadata.uid}{"\\n"}'
kubectl -n buzz-agents exec statefulset/buzz-agent-prime-example -- \
  buzz-agent-prime doctor
```

The two PVC UIDs must match. Then reconnect through Buzz and verify the named
Prime session created before replacement is available. A recreated pod alone
is not sufficient proof of session recovery.

## Operations

- Back up the PVC-mounted `/var/lib/buzz-agent-prime` directory; see
  [Backup and Restore](backup.md). It includes the workspace subpath, so one
  consistent PVC backup covers session state and repository checkouts.
- Update the image with `kubectl set image statefulset/buzz-agent-prime ...`;
  StatefulSet replacement retains the ordinal PVC.
- The NetworkPolicy allows DNS plus HTTPS/SSH egress needed for the relay,
  providers, Git, and GHCR. Tighten it to your network addresses where
  possible.
- The agent does not need a service-account token or Role/RoleBinding. Do not
  add broad Kubernetes API permissions for this workload.
