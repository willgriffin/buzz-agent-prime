import { accessSync, constants } from "node:fs";
import { join, delimiter } from "node:path";

/**
 * Portable PATH lookup (equivalent to `which`).
 *
 * Returns the absolute path to the first executable named `name` found in the
 * `PATH` directories, or `null` when not found.
 */
export function which(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // If the name already contains a path separator, check it directly.
  if (name.includes("/") || (process.platform === "win32" && name.includes("\\"))) {
    return hasExec(name) ? name : null;
  }

  const path = env["PATH"] ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, name);
    if (hasExec(full)) return full;
  }
  return null;
}

function hasExec(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
