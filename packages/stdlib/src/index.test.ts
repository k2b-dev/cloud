import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ==========================
// Root barrel: optional-peer isolation
// ==========================
//
// `lean-qr` is an optional peer dependency. Re-exporting `./qr` from the root
// barrel would force every consumer to have lean-qr installed (static imports
// are evaluated on resolution). The `qr` module is published under the
// `@k2b/stdlib/qr` subpath instead. This guard catches accidental
// re-introduction of the re-export.

describe("root barrel", () => {
  const indexPath = fileURLToPath(new URL("./index.ts", import.meta.url));
  const indexSrc = readFileSync(indexPath, "utf8");

  it("does not re-export ./qr (would force lean-qr resolution)", () => {
    // Allow mentions in comments; only flag actual export statements.
    const exportLines = indexSrc
      .split("\n")
      .filter((l) => /^\s*export\b/.test(l));
    const offending = exportLines.filter((l) => /["']\.\/qr["']/.test(l));
    expect(offending).toEqual([]);
  });

  it("does not statically import lean-qr", () => {
    const importLines = indexSrc
      .split("\n")
      .filter((l) => /^\s*(import|export).*\bfrom\b/.test(l));
    const offending = importLines.filter((l) => /["']lean-qr/.test(l));
    expect(offending).toEqual([]);
  });
});
