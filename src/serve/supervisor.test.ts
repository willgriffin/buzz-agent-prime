import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Supervisor } from "./supervisor.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (existsSync(path)) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${path}`));
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessGroup(pid: number): void {
  if (pid > 0 && pid !== process.pid) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process group was already reaped.
    }
  }
}

function startTermIgnoringTree(descendantReadyFile: string, parentIgnoresTerm = false): string[] {
  const descendant = [
    'import { renameSync, writeFileSync } from "node:fs";',
    'process.on("SIGTERM", () => {});',
    `writeFileSync(${JSON.stringify(`${descendantReadyFile}.tmp`)}, String(process.pid));`,
    `renameSync(${JSON.stringify(`${descendantReadyFile}.tmp`)}, ${JSON.stringify(descendantReadyFile)});`,
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const parent = [
    'import { spawn } from "node:child_process";',
    `const descendant = spawn(process.execPath, ["--eval", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
    "if (descendant.pid === undefined) process.exit(1);",
    parentIgnoresTerm ? 'process.on("SIGTERM", () => {});' : "",
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  return ["--input-type=module", "--eval", parent];
}

describePosix("Supervisor shutdown", () => {
  it("escalates SIGKILL to the complete process group and reaps the child", async () => {
    const directory = mkdtempSync(join(tmpdir(), "buzz-supervisor-"));
    const descendantPidFile = join(directory, "descendant.pid");
    const supervisor = new Supervisor({
      command: process.execPath,
      args: startTermIgnoringTree(descendantPidFile),
      env: process.env,
      cwd: directory,
      shutdownTimeoutMs: 100,
    });

    supervisor.start();
    const childPid = supervisor.pid;
    try {
      expect(childPid).toBeDefined();
      await waitForFile(descendantPidFile);
      const descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
      expect(descendantPid).toBeGreaterThan(0);

      const startedAt = Date.now();
      await supervisor.shutdown();

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(80);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(isAlive(childPid!)).toBe(false);
      expect(isAlive(descendantPid)).toBe(false);
    } finally {
      if (childPid !== undefined) killProcessGroup(childPid);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("falls back to direct-child signalling when the process group is gone", async () => {
    const directory = mkdtempSync(join(tmpdir(), "buzz-supervisor-"));
    const pidFile = join(directory, "descendant.pid");
    const nativeKill = process.kill.bind(process);
    const supervisor = new Supervisor({
      command: process.execPath,
      args: startTermIgnoringTree(pidFile, true),
      env: process.env,
      cwd: directory,
      shutdownTimeoutMs: 50,
    });

    supervisor.start();
    const childPid = supervisor.pid;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (typeof pid === "number" && pid < 0) {
        const error = Object.assign(new Error("no such process group"), { code: "ESRCH" });
        throw error;
      }
      return nativeKill(pid, signal);
    });

    try {
      expect(childPid).toBeDefined();
      await waitForFile(pidFile);
      await supervisor.shutdown();

      expect(kill).toHaveBeenCalledWith(-childPid!, "SIGTERM");
      expect(kill).toHaveBeenCalledWith(-childPid!, "SIGKILL");
      expect(isAlive(childPid!)).toBe(false);
    } finally {
      kill.mockRestore();
      if (childPid !== undefined) killProcessGroup(childPid);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
