/**
 * E2E test: pod-style restart recovery (Kubernetes/PVC).
 *
 * Verifies that buzz-agent-prime survives a pod-style restart with
 * PVC-backed persistent storage:
 * 1. Simulate a Kubernetes pod with a PVC-mounted state directory
 * 2. Create its workspace subPath before the application starts
 * 3. Create and modify a credential-free local Git checkout
 * 4. Delete the pod and reschedule with the same PVC and subPath
 * 5. Verify the checkout remains intact
 *
 * Uses Docker volumes to simulate PVC behavior (single-replica with
 * persistent volume claim). In a real Kubernetes environment, this
 * maps to a pod deletion and rescheduling with the same PVC.
 *
 * Explicitly gated on BUZZ_AGENT_PRIME_DOCKER_E2E=1. This prevents ordinary
 * test runs from probing Docker; an opted-in run fails if Docker or the image
 * is unavailable.
 *
 * Acceptance criterion: "pod-style restart" scenario passes in CI.
 */

import { afterAll, describe, expect, it } from "vitest";
import {
  isDockerAvailable,
  isDockerImageAvailable,
  removeContainer,
  createVolume,
  removeVolume,
  uniqueContainerName,
  startContainer,
  stopContainer,
  waitForContainerRunning,
  execInContainer,
} from "./helpers/container-harness.js";
import { clearMockChildCache } from "../contract/helpers/mock-child.js";

const testPvcName = uniqueContainerName("buzz-test-pvc");
const testPodName = uniqueContainerName("buzz-test-pod");
const rescheduledPodName = uniqueContainerName("buzz-test-pod-rescheduled");
const workspaceInitializerName = uniqueContainerName("buzz-test-workspace-initializer");

const dockerE2eEnabled = process.env.BUZZ_AGENT_PRIME_DOCKER_E2E === "1";
let dockerFixtureStarted = false;

async function requireDockerImage(): Promise<string> {
  if (!(await isDockerAvailable())) {
    throw new Error("BUZZ_AGENT_PRIME_DOCKER_E2E=1 requires an available Docker daemon");
  }
  const image = "buzz-agent-prime:dev";
  if (!(await isDockerImageAvailable(image))) {
    throw new Error("BUZZ_AGENT_PRIME_DOCKER_E2E=1 requires the buzz-agent-prime:dev image");
  }
  return image;
}

afterAll(async () => {
  if (dockerE2eEnabled && dockerFixtureStarted) {
    await removeContainer(workspaceInitializerName);
    await removeContainer(testPodName);
    await removeContainer(rescheduledPodName);
    await removeVolume(testPvcName);
  }
  clearMockChildCache();
});

describe.skipIf(!dockerE2eEnabled)("Pod-style workspace persistence (PVC simulation)", () => {
  it(
    "retains a modified checkout across PVC-backed pod replacement",
    { timeout: 30000 },
    async () => {
      const image = await requireDockerImage();
      dockerFixtureStarted = true;
      await createVolume(testPvcName);

      // Match the manifest initContainer: create the state-backed subPath before
      // Docker (standing in for Kubernetes) mounts it at /workspace.
      await startContainer({
        name: workspaceInitializerName,
        image,
        volumes: { [testPvcName]: "/var/lib/buzz-agent-prime" },
        entrypoint: "sh",
        command: ["-ec", "mkdir -p /var/lib/buzz-agent-prime/workspace; exec tail -f /dev/null"],
        readOnlyRootFilesystem: true,
        tmpfs: ["/tmp:exec,size=64M"],
      });
      expect(await waitForContainerRunning(workspaceInitializerName)).toBe(true);
      await removeContainer(workspaceInitializerName);

      const stateBackedWorkspaceMounts = [
        { source: testPvcName, target: "/var/lib/buzz-agent-prime" },
        { source: testPvcName, target: "/workspace", subPath: "workspace" },
      ];
      await startContainer({
        name: testPodName,
        image,
        mounts: stateBackedWorkspaceMounts,
        entrypoint: "sh",
        command: ["-ec", "exec tail -f /dev/null"],
        readOnlyRootFilesystem: true,
        tmpfs: ["/tmp:exec,size=64M"],
      });
      expect(await waitForContainerRunning(testPodName)).toBe(true);
      expect(await execInContainer(testPodName, ["id", "-u"])).toBe("1001");
      await execInContainer(testPodName, [
        "sh",
        "-ec",
        [
          "git init -q /workspace/fixture-repository",
          "git -C /workspace/fixture-repository config user.name fixture",
          "git -C /workspace/fixture-repository config user.email fixture@example.invalid",
          "printf 'base revision\\n' > /workspace/fixture-repository/README.md",
          "git -C /workspace/fixture-repository add README.md",
          "git -C /workspace/fixture-repository commit -qm initial",
          "printf 'replacement revision\\n' > /workspace/fixture-repository/README.md",
        ].join("; "),
      ]);

      await stopContainer(testPodName);
      await removeContainer(testPodName);
      await startContainer({
        name: rescheduledPodName,
        image,
        mounts: stateBackedWorkspaceMounts,
        entrypoint: "sh",
        command: ["-ec", "exec tail -f /dev/null"],
        readOnlyRootFilesystem: true,
        tmpfs: ["/tmp:exec,size=64M"],
      });
      expect(await waitForContainerRunning(rescheduledPodName)).toBe(true);
      expect(await execInContainer(rescheduledPodName, ["id", "-u"])).toBe("1001");

      expect(
        await execInContainer(rescheduledPodName, [
          "git",
          "-C",
          "/workspace/fixture-repository",
          "rev-parse",
          "--is-inside-work-tree",
        ]),
      ).toBe("true");
      expect(
        await execInContainer(rescheduledPodName, [
          "cat",
          "/workspace/fixture-repository/README.md",
        ]),
      ).toBe("replacement revision");
      expect(
        await execInContainer(rescheduledPodName, [
          "git",
          "-C",
          "/workspace/fixture-repository",
          "diff",
          "--name-only",
        ]),
      ).toBe("README.md");
    },
  );
});

/**
 * Adapter restart recovery — additional scenario.
 */
describe("Adapter restart recovery — CI scenario definition", () => {
  it("documents the adapter restart scenario", () => {
    const scenario = {
      name: "adapter restart",
      prerequisites: [
        "buzz-acp available",
        "buzz-agent-prime acp implemented (issue #3)",
        "disposable relay available",
      ],
      steps: [
        "start disposable relay",
        "start buzz-acp connected to relay",
        "initialize ACP session via relay",
        "stop buzz-acp (simulate adapter crash)",
        "restart buzz-acp",
        "verify buzz-acp reconnects to relay",
        "verify session state recovered",
      ],
      passes_if: [
        "buzz-acp reconnects to relay after restart",
        "session routing resumes",
        "in-flight messages are not lost (or handled gracefully)",
      ],
    };
    expect(scenario.name).toBe("adapter restart");
    expect(scenario.steps).toHaveLength(7);
  });
});
