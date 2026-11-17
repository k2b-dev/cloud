import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "k2b-map-attribution-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { MapAttribution } = await import("./MapAttribution");
const { mapAttribution } = await import("./map-style");

test("MapAttribution server-renders three named links separated by middle dots", () => {
  const html = renderToString(() => createComponent(MapAttribution, {}));
  const links = [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
  expect(links.map((match) => ({ href: match[1], label: match[2] }))).toEqual([...mapAttribution]);
  // Read the text nodes between tags instead of stripping markup, which reads like an HTML sanitizer.
  const text = [...`>${html}<`.matchAll(/>([^<]*)</g)].map((match) => match[1]).join("");
  expect(text).toBe("© OpenStreetMap · © OpenMapTiles · Geoapify");
});
