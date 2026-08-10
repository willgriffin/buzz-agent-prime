import { runAcpCommand } from "./acp/index.js";
import { serve } from "./serve/serve.js";
import { runDoctor } from "./serve/doctor.js";
import { runPrThread } from "./buzz/pr-thread.js";
import { version } from "./version.js";

export const COMMANDS = ["acp", "serve", "doctor", "pr-thread", "version"] as const;
export type Command = (typeof COMMANDS)[number];
const EVENT_ID_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_USAGE_ERROR_LENGTH = 240;
const ANSI_ESCAPE_SEQUENCE =
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)|\u001b[()][0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/g;
const SENSITIVE_USAGE_VALUE =
  /\bnsec|[0-9a-f]{64}|\b[a-z][a-z\d+.-]*:\/\/[^\s/?#@]+@|\b(?:bearer|basic)\s+\S+|\b(?:api(?:[-_ ]?key)?|access(?:[-_ ]?token)?|auth(?:orization)?|password|secret|token)\s*(?:=|:)\s*\S+|[?&](?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|secret|token)=[^&#\s]*/i;

const USAGE = `buzz-agent-prime - Run Prime Agent as a persistent Buzz-native agent

Usage:
  buzz-agent-prime <command> [options]

Commands:
  acp       Speak ACP v2 NDJSON over stdin/stdout (session multiplexer)
  serve     Launch buzz-acp and supervise Prime sessions
  doctor    Diagnose the runtime environment
  pr-thread Resolve a Buzz PR conversation (<event>, --event <id>, or --event=<id>)
  version   Print the installed version
  help      Show this help
`;

/**
 * Dispatch a CLI invocation. Returns the process exit code.
 */
export async function run(argv: readonly string[]): Promise<number> {
  const [command] = argv;

  if (command === undefined || command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  switch (command) {
    case "version":
      process.stdout.write(`${version()}\n`);
      return 0;
    case "acp":
      return runAcpCommand();
    case "serve":
      return serve();
    case "doctor":
      return runDoctor();
    case "pr-thread": {
      const parsed = parsePrThreadArguments(argv.slice(1));
      if ("error" in parsed) {
        const diagnostic = sanitizeCliUsageError(parsed.error, "invalid command argument");
        process.stderr.write(`buzz-agent-prime pr-thread: ${diagnostic}\n`);
        return 2;
      }
      return runPrThread({ event: parsed.event });
    }
    default:
      process.stderr.write(
        `buzz-agent-prime: ${sanitizeCliUsageError(`unknown command '${command}'`, "unknown command")}\n\n`,
      );
      process.stderr.write(USAGE);
      return 2;
  }
}

/** Keep raw CLI arguments terminal-safe and out of diagnostics when sensitive. */
function sanitizeCliUsageError(message: string, sensitiveMessage: string): string {
  const sanitized = message
    .replace(ANSI_ESCAPE_SEQUENCE, " ")
    .replace(CONTROL_CHARACTER, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (SENSITIVE_USAGE_VALUE.test(sanitized) || sanitized.length === 0) {
    return sensitiveMessage;
  }
  return sanitized.length > MAX_USAGE_ERROR_LENGTH
    ? `${sanitized.slice(0, MAX_USAGE_ERROR_LENGTH - 1)}…`
    : sanitized;
}

/** Parse the one required PR event id without accepting ambiguous argument forms. */
export function parsePrThreadArguments(
  args: readonly string[],
): { event: string } | { error: string } {
  let event: string | undefined;

  const setEvent = (value: string): string | undefined => {
    if (event !== undefined) {
      return "event id may be provided only once";
    }
    event = value;
    return undefined;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      return { error: "an event id is required" };
    }
    if (arg === "--event") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: "--event requires a 64-character hexadecimal id" };
      }
      index += 1;
      const error = setEvent(value);
      if (error) return { error };
    } else if (arg.startsWith("--event=")) {
      const error = setEvent(arg.slice("--event=".length));
      if (error) return { error };
    } else if (arg.startsWith("-")) {
      return { error: `unsupported option '${arg}'` };
    } else {
      const error = setEvent(arg);
      if (error) return { error };
    }
  }

  if (event === undefined) {
    return { error: "an event id is required (use <id>, --event <id>, or --event=<id>)" };
  }
  if (!EVENT_ID_PATTERN.test(event)) {
    return { error: "event id must be 64 hexadecimal characters" };
  }
  return { event };
}
