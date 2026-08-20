import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAppFavicon, tablerIconName, writeAppFavicon } from "./app-favicon";

describe("app favicon", () => {
  test("extracts the documented Tabler icon class", () => {
    expect(tablerIconName("ti ti-mail")).toBe("mail");
    expect(() => tablerIconName("mail")).toThrow('such as "ti ti-mail"');
    expect(() => tablerIconName("ti ti-mail extra")).toThrow('such as "ti ti-mail"');
  });

  test("renders a large icon with the Cloud gradient", () => {
    const source = '<svg viewBox="0 0 24 24"><path d="M3 7h18" /></svg>';

    const svg = renderAppFavicon(source);
    expect(svg).toContain('<linearGradient id="cloud-icon"');
    expect(svg).toContain(".start { stop-color: #3b82f6; }");
    expect(svg).toContain(".end { stop-color: #1d4ed8; }");
    expect(svg).toContain("@media (prefers-color-scheme: dark)");
    expect(svg).toContain(".start { stop-color: #f0f6ff; }");
    expect(svg).toContain(".end { stop-color: #1f8bff; }");
    expect(svg).toContain('stroke="url(#cloud-icon)"');
    expect(svg).toContain('stroke-width="2"');
    expect(svg).not.toContain("<rect");
    expect(svg).not.toContain("<filter");
    expect(svg).toContain('<path d="M3 7h18" />');
  });

  test("writes a declared Tabler icon and rejects an unknown one", async () => {
    const publicDir = await mkdtemp(join(tmpdir(), "cloud-app-favicon-"));
    try {
      const target = await writeAppFavicon({ publicDir, appId: "mail", icon: "ti ti-mail" });
      const svg = await readFile(target, "utf8");
      expect(svg).toContain('stroke="url(#cloud-icon)"');
      expect(svg).toContain('d="M3 7l9 6l9 -6"');

      const tableTarget = await writeAppFavicon({ publicDir, appId: "grids", icon: "ti ti-table" });
      expect(await readFile(tableTarget, "utf8")).toContain('d="M3 10h18"');

      await expect(writeAppFavicon({ publicDir, appId: "missing", icon: "ti ti-definitely-not-real" })).rejects.toThrow(
        'Unknown Tabler app icon "ti ti-definitely-not-real"',
      );
    } finally {
      await rm(publicDir, { recursive: true, force: true });
    }
  });
});
