/**
 * Compatibility pin extraction and validation.
 *
 * Parses the pinned-revisions table from `docs/compatibility.md` so that
 * a release gate can refuse to publish when pins are missing, malformed,
 * or set to `latest` instead of an immutable digest or tag.
 *
 * @module scripts/release/compatibility
 */

export interface CompatibilityPin {
  component: string;
  source: string;
  pin: string;
  notes: string;
}

const TABLE_HEADER_RE = /^\|\s*Component\s*\|.*$/;
const TABLE_SEPARATOR_RE = /^\|[-\s|]+\|$/;

/** Parse the pinned-revisions table from compatibility.md content. */
export function parseCompatibilityPins(md: string): CompatibilityPin[] {
  const lines = md.split("\n");
  let i = 0;
  // Find the first table header that starts with "| Component".
  while (i < lines.length && !TABLE_HEADER_RE.test(lines[i] ?? "")) i++;
  if (i >= lines.length) return [];
  // Skip header row.
  i++;
  // Skip separator row.
  if (i < lines.length && TABLE_SEPARATOR_RE.test(lines[i] ?? "")) i++;
  // Read data rows until a blank line or end-of-file.
  const pins: CompatibilityPin[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break;
    const m = /^\|\s*([^|]+)\|([^|]*)\|([^|]*)\|([^|]*)\|$/.exec(line);
    if (!m) continue;
    const component = (m[1] ?? "").trim();
    const source = (m[2] ?? "").trim();
    const pin = (m[3] ?? "").trim();
    const notes = (m[4] ?? "").trim();
    if (component === "") continue;
    pins.push({ component, source, pin, notes });
  }
  return pins;
}

/** Reject pins that are not immutable (e.g. `latest`, `master`, bare semver range). */
export function validatePin(pin: string): boolean {
  const trimmed = pin.trim();
  if (trimmed === "" || trimmed === "latest" || trimmed === "master" || trimmed === "main") {
    return false;
  }
  // Allow: git commit SHA (40+ hex), tag (vX.Y.Z or similar), pinned image digest (@sha256:...),
  // major-version track for runtime platforms (e.g. "22", "3.12").
  if (/^[0-9a-f]{40}$/.test(trimmed)) return true; // git SHA
  if (/^v\d+\.\d+\.\d+/.test(trimmed)) return true; // tagged release
  if (/^[0-9a-f]{7,}$/.test(trimmed)) return true; // short SHA (at least 7 hex chars)
  if (/^@sha256:[0-9a-f]{64}$/.test(trimmed)) return true; // container digest
  if (/^\d+(\.\d+)?$/.test(trimmed)) return true; // runtime major/minor track (22, 3.12)
  if (/^[\w.-]+@[0-9a-f]{7,40}$/.test(trimmed)) return true; // ref@sha
  return false;
}

export interface CompatibilityCheckResult {
  ok: boolean;
  errors: string[];
  pins: CompatibilityPin[];
}

/** Full compatibility gate: parse pins, validate each, and report violations. */
export function checkCompatibility(md: string): CompatibilityCheckResult {
  const pins = parseCompatibilityPins(md);
  const errors: string[] = [];
  if (pins.length === 0) {
    return { ok: false, errors: ["no compatibility pins found in compatibility.md"], pins };
  }
  for (const p of pins) {
    if (!validatePin(p.pin)) {
      errors.push(`pin for "${p.component}" is not immutable: "${p.pin}"`);
    }
  }
  return { ok: errors.length === 0, errors, pins };
}
