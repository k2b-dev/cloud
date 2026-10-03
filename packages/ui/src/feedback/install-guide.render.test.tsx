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

describe("InstallGuide", () => {
  test("iPhone and iPad get the Safari Share steps and the app's note", () => {
    const html = render(prompt("apple-mobile"), "en", "Notifications need the Home Screen app.");
    expect(html).toContain('data-platform="apple-mobile"');
    expect(html).toContain("open this page in Safari");
    expect(steps(html)).toEqual(["Open Share", "Add to Home Screen", "Confirm Add"]);
    expect(html).toContain("Notifications need the Home Screen app.");
    expect(html).not.toContain("No installation option?");
  });

  test("Safari on a Mac adds to the Dock", () => {
    expect(steps(render(prompt("apple-desktop")))).toEqual(["Open the Safari menu", "Add to Dock"]);
  });

  test("Android and other browsers use the browser menu and admit when installation is unavailable", () => {
    const android = render(prompt("android"));
    expect(steps(android)).toEqual(["Open the browser menu", "Install app"]);
    expect(android).toContain("“Add to Home screen”");
    expect(android).toContain("No installation option?");
    const generic = render(prompt("generic"));
    expect(generic).toContain("an installation icon in the address bar");
  });

  test("an embedded browser copies the link for Safari or Chrome instead of listing steps", () => {
    const html = render(prompt("in-app"));
    expect(html).toContain("Open it in Safari or Chrome to install Northwind.");
    expect(html).toContain("Copy app link");
    expect(html).toContain("Paste the link into Safari or Chrome to install Northwind.");
    expect(steps(html)).toEqual([]);
    expect(render(prompt("in-app"), "en", "Then choose Install app in the menu.")).toContain("Then choose Install app in the menu.");
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
    expect(render(prompt("in-app"), "de")).toContain("um Northwind zu installieren");
  });
});
