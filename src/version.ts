import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Package version read from the installed package.json (works from dist/). */
export function version(): string {
  return (require("../package.json") as { version: string }).version;
}
