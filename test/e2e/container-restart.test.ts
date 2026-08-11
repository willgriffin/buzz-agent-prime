/**
 * E2E test: container restart recovery.
 *
 * Verifies that a real Git checkout in the agent workspace survives a
 * container replacement:
 * 1. Start the image with the deployment's named state and workspace volumes
 * 2. Initialize a credential-free fixture repository and modify a tracked file
 * 3. Remove the container and recreate it with the same volumes
 * 4. Verify the checkout and uncommitted change remain intact
 *
 * Uses Docker volumes to simulate persistent storage.
 * Explicitly gated on BUZZ_AGENT_PRIME_DOCKER_E2E=1. This keeps the ordinary
 * test suite from probing a local Docker CLI; once opted in, missing Docker or
 * the required local image fails the test instead of being reported as a pass.
 *
 * Acceptance criterion: "container restart" scenario passes in CI.
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

const testStateVolumeName = uniqueContainerName("buzz-test-state");
const testWorkspaceVolumeName = uniqueContainerName("buzz-test-workspace");
const testContainerName = uniqueContainerName("buzz-test-container");
const replacementContainerName = uniqueContainerName("buzz-test-container-replacement");

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
    await removeContainer(testContainerName);
    await removeContainer(replacementContainerName);
    await removeVolume(testStateVolumeName);
    await removeVolume(testWorkspaceVolumeName);
  }
  clearMockChildCache();
});

describe.skipIf(!dockerE2eEnabled)("Container workspace persistence", () => {
  it("retains a modified checkout after container replacement", { timeout: 30000 }, async () => {
    const image = await requireDockerImage();
    dockerFixtureStarted = true;
    await createVolume(testStateVolumeName);
    await createVolume(testWorkspaceVolumeName);

    await startContainer({
      name: testContainerName,
      image,
      volumes: {
        [testStateVolumeName]: "/var/lib/buzz-agent-prime",
        [testWorkspaceVolumeName]: "/workspace",
      },
      entrypoint: "sh",
      command: ["-ec", "exec tail -f /dev/null"],
      readOnlyRootFilesystem: true,
      tmpfs: ["/tmp:exec,size=64M"],
    });
    expect(await waitForContainerRunning(testContainerName)).toBe(true);
    expect(await execInContainer(testContainerName, ["id", "-u"])).toBe("1001");

    await execInContainer(testContainerName, [
      "sh",
      "-ec",
      [
        "git init -q /workspace/fixture-repository",
        "git -C /workspace/fixture-repository config user.name fixture",
        "git -C /workspace/fixture-repository config user.email fixture@example.invalid",
        "printf 'first revision\\n' > /workspace/fixture-repository/README.md",
        "git -C /workspace/fixture-repository add README.md",
        "git -C /workspace/fixture-repository commit -qm initial",
        "printf 'second revision\\n' > /workspace/fixture-repository/README.md",
        "printf 'untracked fixture\\n' > /workspace/fixture-repository/untracked.txt",
      ].join("; "),
    ]);

    await stopContainer(testContainerName);
    await removeContainer(testContainerName);

    await startContainer({
      name: replacementContainerName,
      image,
      volumes: {
        [testStateVolumeName]: "/var/lib/buzz-agent-prime",
        [testWorkspaceVolumeName]: "/workspace",
      },
      entrypoint: "sh",
      command: ["-ec", "exec tail -f /dev/null"],
      readOnlyRootFilesystem: true,
      tmpfs: ["/tmp:exec,size=64M"],
    });
    expect(await waitForContainerRunning(replacementContainerName)).toBe(true);
    expect(await execInContainer(replacementContainerName, ["id", "-u"])).toBe("1001");

    expect(
      await execInContainer(replacementContainerName, [
        "git",
        "-C",
        "/workspace/fixture-repository",
        "rev-parse",
        "--is-inside-work-tree",
      ]),
    ).toBe("true");
    expect(
      await execInContainer(replacementContainerName, [
        "cat",
        "/workspace/fixture-repository/README.md",
      ]),
    ).toBe("second revision");
    expect(
      await execInContainer(replacementContainerName, [
        "cat",
        "/workspace/fixture-repository/untracked.txt",
      ]),
    ).toBe("untracked fixture");
    expect(
      await execInContainer(replacementContainerName, [
        "git",
        "-C",
        "/workspace/fixture-repository",
        "diff",
        "--name-only",
      ]),
    ).toBe("README.md");
    expect(
      await execInContainer(replacementContainerName, [
        "git",
        "-C",
        "/workspace/fixture-repository",
        "ls-files",
        "--others",
        "--exclude-standard",
      ]),
    ).toBe("untracked.txt");
  });
});
