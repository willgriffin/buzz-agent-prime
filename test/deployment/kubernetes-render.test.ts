import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const basePath = resolve(repositoryRoot, "deploy/kubernetes/base");
const examplePath = resolve(repositoryRoot, "deploy/kubernetes/overlays/example");
const kubectlAvailable =
  spawnSync("kubectl", ["version", "--client"], {
    stdio: "ignore",
  }).status === 0;

function renderKustomization(path: string): string {
  return execFileSync("kubectl", ["kustomize", path], { encoding: "utf8" });
}

function renderedStatefulSet(manifest: string): string {
  return manifest.split("\n---\n").find((document) => /^kind: StatefulSet$/m.test(document)) ?? "";
}

function namesIn(block: string, indent: number): Set<string> {
  return new Set(
    [...block.matchAll(new RegExp(`^ {${indent}}name: (.+)$`, "gm"))].map((match) => match[1]),
  );
}

function assertRenderedStatefulSet(path: string, expectedName: string): void {
  const manifest = renderKustomization(path);
  const statefulSet = renderedStatefulSet(manifest);
  expect(manifest).toMatch(/^kind: Service$/m);
  expect(manifest).toMatch(/^kind: NetworkPolicy$/m);
  expect(manifest).not.toMatch(
    /^kind: (ServiceAccount|Role|RoleBinding|ClusterRole|ClusterRoleBinding)$/m,
  );
  expect(statefulSet).not.toBe("");
  expect(statefulSet).toContain(`name: ${expectedName}`);
  expect(statefulSet).toContain("namespace: buzz-agents");
  expect(statefulSet).toContain("name: buzz-agent-prime-secrets");
  expect(statefulSet).toContain("runAsNonRoot: true");
  expect(statefulSet).toContain("readOnlyRootFilesystem: true");
  expect(statefulSet).toContain("allowPrivilegeEscalation: false");
  expect(statefulSet).toContain("- ALL");
  expect(statefulSet).toContain("type: RuntimeDefault");
  expect(statefulSet).toContain("terminationGracePeriodSeconds: 30");
  expect(statefulSet).toContain("resources:");

  const mounts = namesIn(
    statefulSet.match(/        volumeMounts:\n([\s\S]*?)\n        livenessProbe:/)?.[1] ?? "",
    10,
  );
  const volumes = namesIn(
    statefulSet.match(/      volumes:\n([\s\S]*?)\n  volumeClaimTemplates:/)?.[1] ?? "",
    8,
  );
  const claimTemplates = namesIn(
    statefulSet.match(/  volumeClaimTemplates:\n([\s\S]*)$/)?.[1] ?? "",
    6,
  );

  expect([...mounts].filter((name) => !volumes.has(name) && !claimTemplates.has(name))).toEqual([]);
  expect(claimTemplates).toEqual(new Set(["state"]));
  expect(statefulSet).not.toContain("buzz-agent-prime-state");
}

describe("Kubernetes kustomizations", () => {
  it("declares Service and NetworkPolicy as resources, not patches", () => {
    const baseKustomization = readFileSync(resolve(basePath, "kustomization.yaml"), "utf8");

    expect(baseKustomization).toMatch(
      /resources:\n  - statefulset.yaml\n  - service.yaml\n  - network-policy.yaml/,
    );
    expect(baseKustomization).not.toMatch(/patches:[\s\S]*- service.yaml/);
    expect(baseKustomization).not.toMatch(/patches:[\s\S]*- network-policy.yaml/);
    expect(existsSync(resolve(basePath, "service.yaml"))).toBe(true);
    expect(existsSync(resolve(basePath, "network-policy.yaml"))).toBe(true);
    expect(readFileSync(resolve(examplePath, "kustomization.yaml"), "utf8")).not.toContain(
      "secretGenerator",
    );
  });

  it.skipIf(!kubectlAvailable)(
    "renders the base with resolvable mounts and hardened pod settings",
    () => {
      assertRenderedStatefulSet(basePath, "buzz-agent-prime");
    },
  );

  it.skipIf(!kubectlAvailable)(
    "renders the example overlay with the same external Secret contract",
    () => {
      assertRenderedStatefulSet(examplePath, "buzz-agent-prime-example");
    },
  );
});
