import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-map-attribution-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { MapAttribution } = await import("./MapAttribution");
const { mapAttribution } = await import("./map-style");

test("MapAttribution server-renders three named links separated by middle dots", () => {
  const html = renderToString(() => createComponent(MapAttribution, {}));
  const links = [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
  expect(links.map((match) => ({ href: match[1], label: match[2] }))).toEqual([...mapAttribution]);
  expect(html.replace(/<!--.*?-->|<[^>]+>/g, "")).toBe("© OpenStreetMap · © OpenMapTiles · Geoapify");
});
