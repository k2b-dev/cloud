import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-match-text-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { MatchText, matchParts } = await import("./MatchText");

describe("MatchText", () => {
  test("counts code points, not UTF-16 units, and keeps the whole text", () => {
    // "🧾" is two UTF-16 units but one code point, so "Re" starts at 2.
    expect(matchParts("🧾 Rechnung", [[2, 4]])).toEqual([
      { text: "🧾 ", hit: false },
      { text: "Re", hit: true },
      { text: "chnung", hit: false },
    ]);
  });

  test("clips, sorts and merges overlapping or touching ranges", () => {
    expect(
      matchParts("Bäckerei", [
        [5, 99],
        [0, 2],
        [1, 3],
        [3, 4],
        [-4, 0],
      ]),
    ).toEqual([
      { text: "Bäck", hit: true },
      { text: "e", hit: false },
      { text: "rei", hit: true },
    ]);
    expect(matchParts("plain")).toEqual([{ text: "plain", hit: false }]);
    expect(matchParts("")).toEqual([{ text: "", hit: false }]);
  });

  test("renders marks on the server", () => {
    const html = renderToString(() => createComponent(MatchText, { text: "Alte Rechnung.pdf", ranges: [[5, 13]] }));
    expect(html.replace(/<!--[^>]*-->/g, "")).toBe('Alte <mark class="k2b-match-text__hit">Rechnung</mark>.pdf');
  });
});
