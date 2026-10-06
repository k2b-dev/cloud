import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { InstallationPlatform, InstallPrompt } from "./install";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-install-guide-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { InstallGuide, LocaleProvider } = await import("../index");

const prompt = (
  platform: InstallationPlatform,
  state: Partial<Record<"canPrompt" | "requested" | "failed", boolean>> = {},
): InstallPrompt => ({
  platform,
  installed: () => false,
  canPrompt: () => state.canPrompt ?? false,
  busy: () => false,
  requested: () => state.requested ?? false,
  failed: () => state.failed ?? false,
  install: async () => {},
});

const render = (install: InstallPrompt, locale = "en", note?: string) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(InstallGuide, { appName: "Northwind", install, url: "https://cloud.example/pwa/", note });
      },
    }),
  );

const steps = (html: string) => [...html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((match) => match[1]);

const notice = (html: string) =>
  html.match(/<article[^>]*data-tone="(\w+)"[^>]*>.*?<p class="k2b-notice-card__title">([^<]+)<\/p>/)?.slice(1);

describe("InstallGuide", () => {
  test("Safari on iPhone and iPad gets the Share steps, a fallback for other apps, and the app's note", () => {
    const html = render(prompt("apple-mobile"), "en", "Notifications need the Home Screen app.");
    expect(html).toContain('data-platform="apple-mobile"');
    expect(steps(html)).toEqual(["Open Share", "Add to Home Screen", "Confirm Add"]);
    expect(notice(html)).toBeUndefined();
    expect(html).toContain("This page may be open inside another app. Open it in Safari.");
    expect(html).toContain("Notifications need the Home Screen app.");
    expect(html).not.toContain("No installation option?");
  });

  test("another browser on iPhone recommends Safari above its own Share steps", () => {
    const html = render(prompt("apple-browser"));
    expect(notice(html)).toEqual(["info", "Safari works best"]);
    expect(steps(html)).toEqual(["Open Share", "Add to Home Screen", "Confirm Add"]);
    expect(html).toContain("In Chrome, tap Share in the address bar.");
    expect(html).not.toContain("Copy link");
  });

  test("Safari on a Mac adds to the Dock", () => {
    expect(steps(render(prompt("apple-desktop")))).toEqual(["Open the Safari menu", "Add to Dock"]);
  });

  test("Android and other browsers use the browser menu; only unknown browsers hear that installation may be missing", () => {
    const android = render(prompt("android"));
    expect(steps(android)).toEqual(["Open the browser menu", "Install app"]);
    expect(android).toContain("“Add to Home screen”");
    expect(notice(android)).toBeUndefined();
    expect(android).not.toContain("No installation option?");
    const other = render(prompt("android-browser"));
    expect(notice(other)).toEqual(["info", "Chrome works best"]);
    expect(steps(other)).toEqual(["Open the browser menu", "Install app"]);
    const generic = render(prompt("generic"));
    expect(generic).toContain("an installation icon in the address bar");
    expect(generic).toContain("No installation option?");
  });

  test("an app's own browser view warns and copies the link for Safari or Chrome instead of listing steps", () => {
    const apple = render(prompt("apple-in-app"), "en", "Then choose Install app in the menu.");
    expect(notice(apple)).toEqual(["warning", "Open this page in Safari"]);
    expect(apple).toContain("which can’t install Northwind");
    expect(apple).toMatch(/<button[^>]*>.*Copy link/);
    expect(steps(apple)).toEqual([]);
    expect(apple).toContain("Then choose Install app in the menu.");
    const other = render(prompt("in-app"));
    expect(notice(other)).toEqual(["warning", "Open this page in your browser"]);
    expect(other).toContain("paste it into Chrome");
    expect(steps(other)).toEqual([]);
  });

  test("Samsung Internet is sent to Chrome with the warning explained, even when it offers its own dialog", () => {
    for (const canPrompt of [false, true]) {
      const html = render(prompt("android-samsung", { canPrompt }), "en", "Notifications work in the app.");
      expect(notice(html)).toEqual(["info", "Install with Chrome"]);
      expect(html).toContain("“built for an older version of Android”. The warning is about that package, not about Northwind.");
      expect(html).toContain(
        'href="intent://cloud.example/pwa/#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fcloud.example%2Fpwa%2F;end"',
      );
      expect(html).toContain("Open in Chrome");
      expect(html).not.toContain("Install app");
      expect(steps(html)).toEqual([]);
      expect(html).toContain("Notifications work in the app.");
    }
    const german = render(prompt("android-samsung"), "de");
    expect(notice(german)).toEqual(["info", "Mit Chrome installieren"]);
    expect(german).toContain("„für eine ältere Android-Version entwickelt“");
    expect(german).toContain("In Chrome öffnen");
  });

  test("the browser's own dialog, its request, and its failure replace the steps", () => {
    const native = render(prompt("android", { canPrompt: true }));
    expect(native).toContain("Your browser can install Northwind.");
    expect(native).toMatch(/<button[^>]*>.*Install app/);
    expect(steps(native)).toEqual([]);
    expect(render(prompt("android", { requested: true }))).toContain('role="status">Installation requested.');
    expect(render(prompt("generic", { failed: true }))).toContain('role="alert">The installation dialog could not be opened.');
  });

  test("speaks German from the inherited locale", () => {
    const html = render(prompt("apple-mobile"), "de");
    expect(steps(html)).toEqual(["Teilen öffnen", "Zum Home-Bildschirm", "Hinzufügen bestätigen"]);
    const embedded = render(prompt("apple-in-app"), "de");
    expect(notice(embedded)).toEqual(["warning", "Öffne diese Seite in Safari"]);
    expect(embedded).toContain("die Northwind nicht installieren kann");
    expect(embedded).toContain("Link kopieren");
    expect(notice(render(prompt("apple-browser"), "de"))).toEqual(["info", "Am besten mit Safari"]);
  });
});
