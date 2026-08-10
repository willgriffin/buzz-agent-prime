import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const IMAGE = "buzz-agent-prime:dev";

function hasRuntimeImage(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

describe("container runtime dependency closure", () => {
  it("includes the production ESM dependencies used by the relay", { timeout: 30_000 }, () => {
    if (!hasRuntimeImage()) return;

    const output = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "/usr/local/bin/node",
        IMAGE,
        "--input-type=module",
        "-e",
        "await import('/opt/buzz-agent-prime/node_modules/@noble/secp256k1/index.js'); await import('/opt/buzz-agent-prime/node_modules/@noble/hashes/sha2.js'); await import('/opt/buzz-agent-prime/node_modules/@scure/base/index.js'); process.stdout.write('runtime-dependencies-ok')",
      ],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 25_000 },
    );
    expect(output).toContain("runtime-dependencies-ok");
  });
});
