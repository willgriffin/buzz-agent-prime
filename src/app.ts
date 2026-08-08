import { version } from "./version.js";

export const COMMANDS = ["acp", "serve", "doctor", "version"] as const;
export type Command = (typeof COMMANDS)[number];

const USAGE = `buzz-agent-prime - Run Prime Agent as a persistent Buzz-native agent

Usage:
  buzz-agent-prime <command> [options]

Commands:
  acp       Speak ACP v2 NDJSON over stdin/stdout (session multiplexer; issue #3)
  serve     Launch buzz-acp and supervise Prime sessions (issue #4)
  doctor    Diagnose the runtime environment (issue #4)
  version   Print the installed version
  help      Show this help
`;

/**
 * Dispatch a CLI invocation. Returns the process exit code.
 * Command implementations beyond `version` land in issues #3/#4; the names
 * are reserved here so the public contract is stable from day one.
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
      process.stderr.write(
        "buzz-agent-prime acp: not implemented yet (core multiplexer, issue #3)\n",
      );
      return 1;
    case "serve":
      process.stderr.write(
        "buzz-agent-prime serve: not implemented yet (runtime supervision, issue #4)\n",
      );
      return 1;
    case "doctor":
      process.stderr.write(
        "buzz-agent-prime doctor: not implemented yet (runtime diagnostics, issue #4)\n",
      );
      return 1;
    default:
      process.stderr.write(`buzz-agent-prime: unknown command '${command}'\n\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}
