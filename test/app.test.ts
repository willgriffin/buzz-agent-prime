import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const { runPrThread } = vi.hoisted(() => ({ runPrThread: vi.fn().mockResolvedValue(0) }));
vi.mock("../src/buzz/pr-thread.js", () => ({ runPrThread }));

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
  beforeEach(() => {
    vi.clearAllMocks();
    runPrThread.mockResolvedValue(0);
  });

  it("reserves the five public commands", async () => {
    // `acp` now launches the multiplexer (waits on stdin); test it separately.
    // serve/doctor need a writable state dir; override to a test tmp path.
    const oldStateDir = process.env.BUZZ_AGENT_PRIME_STATE_DIR;
    process.env.BUZZ_AGENT_PRIME_STATE_DIR = "/tmp/buzz-test-state";
    try {
      for (const command of ["serve", "doctor", "version"]) {
        const code = await run([command]);
        expect([0, 1, 3]).toContain(code);
      }
    } finally {
      if (oldStateDir) process.env.BUZZ_AGENT_PRIME_STATE_DIR = oldStateDir;
      else delete process.env.BUZZ_AGENT_PRIME_STATE_DIR;
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

  it("ships the pr-thread contract documentation in the npm package", () => {
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        encoding: "utf8",
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    expect(packed[0]?.files.map((file) => file.path)).toContain("docs/pr-thread.md");
  });

  it.each([["a".repeat(64)], ["--event=" + "b".repeat(64)], ["--event", "c".repeat(64)]])(
    "passes each supported pr-thread event argument form through once",
    async (...args) => {
      const expectedEvent = args.length === 1 ? args[0]!.replace(/^--event=/, "") : args[1]!;

      await expect(run(["pr-thread", ...args])).resolves.toBe(0);
      expect(runPrThread).toHaveBeenCalledTimes(1);
      expect(runPrThread).toHaveBeenCalledWith({ event: expectedEvent });
    },
  );

  it.each([
    [],
    ["--event"],
    ["--event="],
    ["--event=not-a-nostr-id"],
    ["not-a-nostr-id"],
    ["--unknown", "a".repeat(64)],
    ["a".repeat(64), "unexpected"],
  ])("rejects malformed pr-thread input before opening a relay connection", async (...args) => {
    await expect(run(["pr-thread", ...args])).resolves.toBe(2);
    expect(runPrThread).not.toHaveBeenCalled();
  });

  it("sanitizes unsupported secret-looking and C1-controlled CLI options", async () => {
    const secret = "bearer very-secret-value";
    const option = `--token=${secret}\u009b31m`;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(run(["pr-thread", option])).resolves.toBe(2);
      const message = stderr.mock.calls.flat().join("");
      expect(message).not.toContain(secret);
      expect(message.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    } finally {
      stderr.mockRestore();
    }
  });

  it("writes one trailing newline for a generic sanitized parser diagnostic", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(run(["pr-thread", "--plain-option"])).resolves.toBe(2);
      expect(stderr.mock.calls.flat().join("")).toBe(
        "buzz-agent-prime pr-thread: unsupported option '--plain-option'\n",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("preserves a command failure when stdout reports EPIPE after the result is assigned", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const cliUrl = pathToFileURL(path.join(root, "src", "cli.ts")).href;
    const loader = path.join(root, "test", "helpers", "source-ts-loader.mjs");
    const harness = `
      process.argv = [process.execPath, "buzz-agent-prime", "doctor"];
      process.stdout.write = () => true;
      await import(${JSON.stringify(cliUrl)});
      setImmediate(() => {
        process.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        process.stderr.write("exit-code=" + process.exitCode + "\\n");
      });
    `;
    const { error, status, stderr } = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--experimental-loader",
        loader,
        "--input-type=module",
        "--eval",
        harness,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: "", BUZZ_RELAY_URL: "", BUZZ_PRIVATE_KEY: "" },
        timeout: 10_000,
      },
    );

    expect(error).toBeUndefined();
    expect(status).toBe(1);
    expect(stderr).toContain("exit-code=1\n");
  });
});
