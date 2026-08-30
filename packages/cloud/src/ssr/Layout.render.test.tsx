import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";

const root = mkdtempSync(resolve(tmpdir(), "cloud-layout-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { defineApp } = await import("../_internal/define-app");
const { default: Layout } = await import("./Layout");
const { default: MinimalLayout } = await import("./MinimalLayout");

const app = defineApp({
  id: "layout-render-probe",
  name: "Layout render probe",
  icon: "ti ti-layout",
  description: "Anonymous and minimal layout render probe",
  baseUrl: "http://layout-render-probe:3000",
  routes: ["/layout", "/minimal"],
});

type LayoutContextArg = Parameters<typeof Layout>[0]["c"];
type MinimalLayoutContextArg = Parameters<typeof MinimalLayout>[0]["c"];
type PreferencePosition = Exclude<Parameters<typeof MinimalLayout>[0]["preferences"], false | undefined>;
const preferencePositions: PreferencePosition[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

const server = new Hono()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps: [] } as never);
    await next();
  })
  .get(
    "/layout",
    ...app.ssr(
      (c) => () =>
        createComponent(Layout, {
          c: c as unknown as LayoutContextArg,
          fullPage: true,
          title: "Public tools",
          children: "Anonymous content",
        }),
    ),
  )
  .get(
    "/minimal/:position",
    ...app.ssr((c) => {
      const requested = c.req.param("position");
      const preferences = preferencePositions.find((position) => position === requested) ?? false;
      return () =>
        createComponent(MinimalLayout, {
          c: c as unknown as MinimalLayoutContextArg,
          preferences,
          children: "Minimal content",
        });
    }),
  );

describe("Cloud layouts SSR", () => {
  test("keeps anonymous login and preferences visible without rendering the application rail", async () => {
    const response = await server.request("/layout", {
      headers: { Cookie: "theme=dark", "Accept-Language": "de-CH" },
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<html lang="de-CH" class="dark"');
    expect(html).toContain("layout-header");
    expect(html).toContain('href="/auth/login"');
    expect(html).toContain("Anmelden");
    expect(html).toContain("Darstellung und Sprache");
    expect(html).toContain("Heller Modus");
    expect(html).toContain("English");
    expect(html).not.toContain("layout-rail-navigation");
    expect(html).not.toContain('data-layout-authenticated="true"');
    expect(html).not.toContain('href="/me"');
  });

  test("positions minimal preferences in every supported corner without adding Cloud chrome", async () => {
    const expectedMenuPositions = {
      "top-left": "bottom-right",
      "top-right": "bottom-left",
      "bottom-left": "top-right",
      "bottom-right": "top-left",
    } as const;

    for (const position of preferencePositions) {
      const response = await server.request(`/minimal/${position}`, { headers: { "Accept-Language": "en" } });
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(`minimal-layout-preferences--${position}`);
      expect(html).toContain(`data-position="${expectedMenuPositions[position]}"`);
      expect(html).toContain("Appearance and language");
      expect(html).toContain("Minimal content");
      expect(html).not.toContain("cloud-app-canvas");
      expect(html).not.toContain("layout-header");
      expect(html).not.toContain("layout-rail");
    }
  });

  test("can disable the minimal preference control completely", async () => {
    const response = await server.request("/minimal/off");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Minimal content");
    expect(html).not.toContain("minimal-layout-preferences");
    expect(html).not.toContain("Appearance and language");
  });

  test("keeps every corner safe-area aware", async () => {
    const css = await Bun.file(new URL("../styles/utilities-navigation.css", import.meta.url)).text();
    for (const position of preferencePositions) expect(css).toContain(`.minimal-layout-preferences--${position}`);
    expect(css).toContain("env(safe-area-inset-top)");
    expect(css).toContain("env(safe-area-inset-right)");
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toContain("env(safe-area-inset-left)");
  });
});
