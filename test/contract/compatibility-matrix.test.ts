/**
 * Compatibility matrix test — verifies the pinned and next-candidate
 * upstream revisions documented in docs/compatibility.md.
 *
 * This test reads the compatibility matrix from the source of truth
 * (docs/compatibility.md) and validates its structure. It also provides
 * a programmatic artifact for the test matrix that CI can reference.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

interface CompatibilityRow {
  primeAgent: string;
  buzzAcp: string;
  status: string;
}

interface CompatibilityMatrix {
  pinnedTarget: CompatibilityRow;
  nextCandidates: CompatibilityRow[];
}

/**
 * Parse the compatibility matrix from docs/compatibility.md.
 * Expected table format:
 * | prime-agent          | buzz-acp (block/buzz) | Status         |
 * | -------------------- | --------------------- | -------------- |
 * | v0.7.1 (`a18809e0`)  | `3a96acea` (0.5.3)    | Pinned target  |
 * | next candidate (TBD) | `3a96acea` (0.5.3)    | Next-candidate |
 * | v0.7.1 (`a18809e0`)  | next candidate (TBD)  | Next-candidate |
 */
function parseCompatibilityMatrix(docPath: string): CompatibilityMatrix {
  const content = fs.readFileSync(docPath, "utf-8");
  const lines = content.split("\n");

  // Find the "Compatibility matrix" section
  let inMatrix = false;
  let inTable = false;
  const dataRows: string[] = [];

  for (const line of lines) {
    if (line.trim().toLowerCase().startsWith("## compatibility matrix")) {
      inMatrix = true;
      continue;
    }
    if (inMatrix && line.startsWith("## ")) {
      break; // next section
    }
    if (inMatrix && line.startsWith("|")) {
      if (line.includes("---")) {
        inTable = true;
        continue;
      }
      if (inTable) {
        dataRows.push(line);
      }
    }
  }

  expect(dataRows.length).toBeGreaterThan(0);

  const rows: CompatibilityRow[] = dataRows.map((row) => {
    const cells = row
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    return {
      primeAgent: cells[0] ?? "",
      buzzAcp: cells[1] ?? "",
      status: cells[2] ?? "",
    };
  });

  const pinnedTarget = rows.find((r) => r.status.toLowerCase().includes("pinned"));
  const nextCandidates = rows.filter((r) => r.status.toLowerCase().includes("next-candidate"));

  expect(pinnedTarget).toBeDefined();
  expect(nextCandidates.length).toBeGreaterThan(0);

  return {
    pinnedTarget: pinnedTarget!,
    nextCandidates,
  };
}

const COMPAT_DOC = path.resolve(import.meta.dirname, "..", "..", "docs", "compatibility.md");

describe("Compatibility matrix — structure", () => {
  it("docs/compatibility.md exists", () => {
    expect(fs.existsSync(COMPAT_DOC)).toBe(true);
  });

  it("has a pinned target row", () => {
    const matrix = parseCompatibilityMatrix(COMPAT_DOC);
    expect(matrix.pinnedTarget.status.toLowerCase()).toContain("pinned");
  });

  it("has at least one next-candidate row", () => {
    const matrix = parseCompatibilityMatrix(COMPAT_DOC);
    expect(matrix.nextCandidates.length).toBeGreaterThanOrEqual(1);
  });

  it("pinned target specifies a concrete prime-agent version", () => {
    const matrix = parseCompatibilityMatrix(COMPAT_DOC);
    expect(matrix.pinnedTarget.primeAgent).toContain("v0.7.1");
    expect(matrix.pinnedTarget.primeAgent).toContain("a18809e0");
  });

  it("pinned target specifies a concrete buzz-acp version", () => {
    const matrix = parseCompatibilityMatrix(COMPAT_DOC);
    expect(matrix.pinnedTarget.buzzAcp).toContain("3a96acea");
    expect(matrix.pinnedTarget.buzzAcp).toContain("0.5.3");
  });

  it("next-candidate rows mark one component as TBD", () => {
    const matrix = parseCompatibilityMatrix(COMPAT_DOC);
    for (const row of matrix.nextCandidates) {
      const hasTbd =
        row.primeAgent.toLowerCase().includes("tbd") || row.buzzAcp.toLowerCase().includes("tbd");
      expect(hasTbd).toBe(true);
    }
  });
});

describe("Compatibility matrix — pins", () => {
  it("pinned prime-agent commit matches the contract", () => {
    const matrix = parseCompatibilityMatrix(COMPAT_DOC);
    // The contract specifies the exact pin
    expect(matrix.pinnedTarget.primeAgent).toContain(
      "a18809e00ea30638584d87b3afea7285a9d7296c".slice(0, 8),
    );
  });

  it("pinned buzz commit matches the contract", () => {
    const matrix = parseCompatibilityMatrix(COMPAT_DOC);
    expect(matrix.pinnedTarget.buzzAcp).toContain(
      "3a96acea09b4a9e3f02c3a26cfb0607d2ccacf42".slice(0, 8),
    );
  });
});

/**
 * Exported matrix for programmatic use by other tests or CI.
 */
export const COMPAT_MATRIX: CompatibilityMatrix = (() => {
  try {
    return parseCompatibilityMatrix(COMPAT_DOC);
  } catch {
    // Fallback for when docs aren't available (shouldn't happen in CI)
    return {
      pinnedTarget: {
        primeAgent: "v0.7.1 (a18809e0)",
        buzzAcp: "3a96acea (0.5.3)",
        status: "Pinned target",
      },
      nextCandidates: [
        {
          primeAgent: "next candidate (TBD)",
          buzzAcp: "3a96acea (0.5.3)",
          status: "Next-candidate",
        },
        {
          primeAgent: "v0.7.1 (a18809e0)",
          buzzAcp: "next candidate (TBD)",
          status: "Next-candidate",
        },
      ],
    };
  }
})();
