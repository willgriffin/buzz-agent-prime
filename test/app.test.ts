import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { run } from "../src/app.js";
import { runAcpCommand } from "../src/acp/index.js";
import { version } from "../src/version.js";

function capture(stdout: () => void): string {
  const original = process.stdout.write;
  let out = "";
  // @ts-expect-error - minimal write spy for tests
  process.stdout.write = (chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  };
  try {
    stdout();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

describe("buzz-agent-prime CLI (foundation contract)", () => {
  it("reserves the four public commands", async () => {
    // `acp` now launches the multiplexer (waits on stdin); test it separately.
    for (const command of ["serve", "doctor", "version"]) {
      const code = await run([command]);
      expect([0, 1]).toContain(code);
    }
  });

  it("acp exits cleanly on stdin EOF", async () => {
    const input = new PassThrough();
    input.end();
    const code = await runAcpCommand({
      primeBin: "/nonexistent/prime-agent",
      input,
      installSignalHandlers: false,
    });
    expect(code).toBe(0);
  }, 10000);

  it("prints the package version", async () => {
    const out = capture(() => {
      void run(["version"]);
    });
    expect(out.trim()).toBe(version());
  });

  it("rejects unknown commands with a non-zero exit code", async () => {
    const code = await run(["frobnicate"]);
    expect(code).toBe(2);
  });

  it("returns the current package version", () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
