import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";

const root = mkdtempSync(resolve(tmpdir(), "cloud-css-layer-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { defineApp } = await import("./define-app");

const app = defineApp({
  id: "layer-probe",
  name: "Layer Probe",
  icon: "ti ti-stack",
  description: "CSS layer order probe",
  baseUrl: "http://layer-probe:3000",
  routes: ["/app/layer-probe"],
});

const server = new Hono().get("/", ...app.ssr(() => () => "layer probe"));

/** Builds a stylesheet the way `scripts/build.ts` builds an app's `app.css`. */
const buildAppCss = async (): Promise<string> => {
  const entry = resolve(root, "app.css");
  const utilities = Bun.resolveSync("tailwindcss/utilities.css", import.meta.dir);
  writeFileSync(entry, `@import ${JSON.stringify(utilities)} layer(utilities) source(none);\n@source inline("translate-x-[3px]");\n`);
  const result = await Bun.build({ entrypoints: [entry], outdir: resolve(root, "out"), naming: "app.css", plugins: [tailwind] });
  const [output] = result.outputs;
  if (!result.success || !output) throw new AggregateError(result.logs, "app.css build failed");
  return await output.text();
};

/** Cascade layer order as the browser settles it: first mention wins. */
const layerOrder = (css: string): string[] => {
  const order: string[] = [];
  for (const [, names = ""] of css.matchAll(/@layer\s+([\w\s,.-]+?)\s*[;{]/g)) {
    for (const name of names.split(",").map((part) => part.trim())) {
      if (name && !order.includes(name)) order.push(name);
    }
  }
  return order;
};

describe("document CSS layer order", () => {
  test("keeps Tailwind's property fallback layer below utilities", async () => {
    const html = await (await server.request("/")).text();
    const declaration = html.match(/<style data-cloud-css-layers>([^<]*)<\/style>/)?.[1];
    expect(declaration).toBeDefined();
    // The declaration must precede every stylesheet so it fixes the order.
    expect(html.indexOf("data-cloud-css-layers")).toBeLessThan(html.indexOf('rel="stylesheet"'));

    const appCss = await buildAppCss();
    // Guard the premise: Tailwind resets `--tw-*` in a `properties` layer for
    // browsers without `@property`, and a later layer beats `translate-x-[3px]`.
    expect(appCss).toContain("@layer properties");
    expect(appCss).toContain("--tw-translate-x: 0");

    expect(layerOrder(`${declaration}\n${appCss}`)).toEqual(["properties", "theme", "base", "components", "utilities"]);
  });
});
