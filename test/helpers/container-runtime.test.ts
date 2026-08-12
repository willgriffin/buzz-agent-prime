import { describe, expect, it } from "vitest";
import { isDockerAvailable, isDockerImageAvailable, runDockerCommand } from "./docker.js";

const IMAGE = "buzz-agent-prime:dev";
const dockerE2eEnabled = process.env.BUZZ_AGENT_PRIME_DOCKER_E2E === "1";

describe.skipIf(!dockerE2eEnabled)("container runtime dependency closure", () => {
  it(
    "includes the production ESM dependencies used by the relay",
    { timeout: 30_000 },
    async () => {
      if (!(await isDockerAvailable())) {
        throw new Error("BUZZ_AGENT_PRIME_DOCKER_E2E=1 requires an available Docker daemon");
      }
      if (!(await isDockerImageAvailable(IMAGE))) {
        throw new Error("BUZZ_AGENT_PRIME_DOCKER_E2E=1 requires the buzz-agent-prime:dev image");
      }

      const output = await runDockerCommand([
        "run",
        "--rm",
        "--entrypoint",
        "/usr/local/bin/node",
        IMAGE,
        "--input-type=module",
        "-e",
        "await import('/opt/buzz-agent-prime/node_modules/@noble/secp256k1/index.js'); await import('/opt/buzz-agent-prime/node_modules/@noble/hashes/sha2.js'); await import('/opt/buzz-agent-prime/node_modules/@scure/base/index.js'); process.stdout.write('runtime-dependencies-ok')",
      ]);
      expect(output).toContain("runtime-dependencies-ok");
    },
  );
});
