import { runAcpCommand } from "./acp/index.js";
import { serve } from "./serve/serve.js";
import { runDoctor } from "./serve/doctor.js";
import { version } from "./version.js";

export const COMMANDS = ["acp", "serve", "doctor", "version"] as const;
export type Command = (typeof COMMANDS)[number];

const USAGE = `buzz-agent-prime - Run Prime Agent as a persistent Buzz-native agent

Usage:
  buzz-agent-prime <command> [options]

Commands:
  acp       Speak ACP v2 NDJSON over stdin/stdout (session multiplexer)
  serve     Launch buzz-acp and supervise Prime sessions
  doctor    Diagnose the runtime environment
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
    default:
      process.stderr.write(`buzz-agent-prime: unknown command '${command}'\n\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}
