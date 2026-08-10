#!/usr/bin/env node

import { run } from "./app.js";

function isBrokenPipe(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}

// This entry point owns the process lifetime. Keep a final stdout guard for
// EPIPEs reported after a command has returned (for example, `| head`).
let stdoutClosed = false;
process.stdout.on("error", (error: Error) => {
  if (isBrokenPipe(error)) {
    stdoutClosed = true;
    if (process.exitCode === undefined || process.exitCode === 0) {
      process.exitCode = 0;
    }
    return;
  }
  process.exitCode = 1;
  process.stderr.write("buzz-agent-prime: stdout write failed\n");
});

const code = await run(process.argv.slice(2));
process.exitCode = code !== 0 ? code : stdoutClosed ? 0 : code;
