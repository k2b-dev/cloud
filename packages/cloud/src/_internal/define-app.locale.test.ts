import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";

const root = mkdtempSync(resolve(tmpdir(), "cloud-locale-ssr-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { defineApp } = await import("./define-app");
const { default: Layout } = await import("../ssr/Layout");
const { getLocale } = await import("../server/locale");
const { getDateConfig } = await import("../server/time");
const { LocaleProvider, useLocale } = await import("@k2b/ui");

/**
 * The locale slice is request-scoped: two concurrent SSR requests with
 * different locale preferences must resolve independently and emit one
 * matching locale for `<html lang>`, the Layout `LocaleProvider`, and
 * `getDateConfig`.
 */

const app = defineApp({
  id: "locale-probe",
  name: "Locale Probe",
  icon: "ti ti-language",
  description: "SSR locale isolation probe",
  baseUrl: "http://locale-probe:3000",
  routes: ["/app/locale-probe"],
});

/** Echoes the inherited `LocaleProvider` locale into the rendered body. */
const LocaleEcho = () => {
  const locale = useLocale();
  return `[[provided-locale:${locale()}]]`;
};

type LayoutContextArg = Parameters<typeof Layout>[0]["c"];

const server = new Hono()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps: [] } as never);
    await next();
  })
  .get(
    "/",
    ...app.ssr((c) => {
      const dateConfig = getDateConfig(c);
      return () =>
        createComponent(Layout, {
          c: c as unknown as LayoutContextArg,
          get children() {
            return [createComponent(LocaleEcho, {}), `[[date-config:${dateConfig.locale}@${dateConfig.timeZone}]]`];
          },
        });
    }),
  )
  .get(
    "/override",
    ...app.ssr((c) => {
      c.get("page").lang = "fr";
      return () =>
        createComponent(Layout, {
          c: c as unknown as LayoutContextArg,
          get children() {
            return createComponent(LocaleEcho, {});
          },
        });
    }),
  )
  .get(
    "/custom",
    ...app.ssr((c) => {
      const locale = getLocale(c);
      return () =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(LocaleEcho, {});
          },
        });
    }),
  );

const htmlLang = (html: string): string | undefined => html.match(/<html lang="([^"]*)"/)?.[1];
const echoedLocale = (html: string): string | undefined => html.match(/\[\[provided-locale:([^\]]*)\]\]/)?.[1];
const echoedDateConfig = (html: string): string | undefined => html.match(/\[\[date-config:([^\]]*)\]\]/)?.[1];

describe("SSR locale isolation", () => {
  test("concurrent requests keep independent locales across html lang, LocaleProvider, and date config", async () => {
    const [swiss, french] = await Promise.all([
      server.request("/", { headers: { "Accept-Language": "de-CH", Cookie: "cloud.timezone=Europe/Zurich" } }),
      server.request("/", { headers: { "Accept-Language": "fr", Cookie: "cloud.timezone=Europe/Paris" } }),
    ]);

    const swissHtml = await swiss.text();
    const frenchHtml = await french.text();

    expect(htmlLang(swissHtml)).toBe("de-CH");
    expect(echoedLocale(swissHtml)).toBe("de-CH");
    expect(echoedDateConfig(swissHtml)).toBe("de-CH@Europe/Zurich");

    expect(htmlLang(frenchHtml)).toBe("fr");
    expect(echoedLocale(frenchHtml)).toBe("fr");
    expect(echoedDateConfig(frenchHtml)).toBe("fr@Europe/Paris");
  });

  test("the explicit locale cookie wins over Accept-Language and stays canonical", async () => {
    const response = await server.request("/", {
      headers: { Cookie: "cloud.locale=DE-ch", "Accept-Language": "en-US" },
    });
    expect(htmlLang(await response.text())).toBe("de-CH");
  });

  test("a page handler cannot override the canonical request locale", async () => {
    const response = await server.request("/override", { headers: { "Accept-Language": "de-CH" } });
    const html = await response.text();
    expect(htmlLang(html)).toBe("de-CH");
    expect(echoedLocale(html)).toBe("de-CH");
  });

  test("preference-free requests fall back deterministically", async () => {
    const response = await server.request("/");
    const html = await response.text();
    expect(htmlLang(html)).toBe("en");
    expect(echoedLocale(html)).toBe("en");
  });

  test("custom SSR roots can bind the same request locale without using Layout", async () => {
    const response = await server.request("/custom", { headers: { "Accept-Language": "de-CH" } });
    const html = await response.text();
    expect(htmlLang(html)).toBe("de-CH");
    expect(echoedLocale(html)).toBe("de-CH");
  });
});
