import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { SecretSave } from "./http-contracts";
import { MachineRights } from "./machine-contracts";

// Studio sharing is the shared access dialog; machine rights and secrets are a section inside it.
const serve = async () => {
  const build = Bun.spawn(
    [process.execPath, new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./machine-permissions-browser-harness.tsx"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../ui/", import.meta.url).pathname))).default;
  const [code, buildError, styles, appStyles] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    Bun.build({ entrypoints: [new URL("../../../../styles.css", import.meta.url).pathname], plugins: [tailwind] }),
    Bun.build({ entrypoints: [new URL("../styles/app.css", import.meta.url).pathname], plugins: [tailwind] }),
  ]);
  if (await build.exited) throw new Error(buildError);
  if (!styles.success || !appStyles.success) throw new AggregateError([...styles.logs, ...appStyles.logs], "Stylesheets did not build.");
  const css = (await styles.outputs[0]!.text()) + (await appStyles.outputs[0]!.text());
  const iconCss = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
  const iconSource = await Bun.file(iconCss).text();
  const iconFont = iconSource.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
  if (!iconFont) throw new Error("Missing Tabler WOFF2 file");
  const icons = { css: iconSource.replace(iconFont, "/tabler.woff2"), font: resolve(dirname(iconCss), iconFont) };
  const policy = (id: string, kind: "agent" | "standalone", name: string) => ({
    entry: {
      id,
      principal: {
        type: "service_account",
        serviceAccountId: kind === "agent" ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
      permission: "read",
      displayName: name,
      serviceAccountKind: kind,
      createdAt: "2026-10-23T12:00:00.000Z",
    },
    rights: MachineRights.parse(
      kind === "agent"
        ? {
            execute: true,
            storage: "write",
            database: "read",
            secrets: ["reportApi"],
            http: [{ origin: "https://api.example.com", methods: ["GET"] }],
          }
        : {},
    ),
    revision: "44444444-4444-4444-8444-444444444444",
    status: kind === "agent" ? "active" : "disabled",
  });
  const state = {
    policies: [
      policy("22222222-2222-4222-8222-222222222222", "agent", "Invoice agent"),
      policy("33333333-3333-4333-8333-333333333333", "standalone", "Reporting service"),
    ],
    failLoad: false,
    failSave: false,
    failSecretSave: false,
    writes: [] as unknown[],
    lookups: [] as string[],
    secretEntries: [] as { name: string; origin: string; header: string; prefix: string; configured: true; revision: string }[],
    waitForLoad: undefined as Promise<void> | undefined,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js") return new Response(code, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/ui.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (url.pathname === "/tabler.css") return new Response(icons.css, { headers: { "content-type": "text/css" } });
      if (url.pathname === "/tabler.woff2") return new Response(Bun.file(icons.font), { headers: { "content-type": "font/woff2" } });
      if (url.pathname.endsWith("/accounts/entities")) {
        state.lookups.push(url.search);
        const handle = url.searchParams.get("search");
        const targeted = url.searchParams.get("target_type") === "assistant.app" && url.searchParams.get("target_id") === "App234";
        return Response.json({
          items:
            targeted && handle === "code-7k2q9m4xwt"
              ? [
                  {
                    kind: "service_account",
                    serviceAccount: {
                      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                      name: "Code von info@beispiel.de",
                      kind: "code",
                      status: "active",
                      handle,
                      description: "Dienstkonto eines Postfachs",
                    },
                  },
                ]
              : [],
          pagination: { total: 0, has_next: false },
        });
      }
      if (url.pathname.endsWith("/secrets")) {
        if (request.method === "PUT") {
          if (state.failSecretSave) return Response.json({ code: "CONFLICT" }, { status: 409 });
          const { value: _value, expectedRevision: _revision, ...metadata } = SecretSave.parse(await request.json());
          const entry = { ...metadata, configured: true as const, revision: "55555555-5555-4555-8555-555555555555" };
          state.secretEntries.push(entry);
          return Response.json(entry);
        }
        return Response.json(state.secretEntries);
      }
      if (url.pathname.endsWith("/access")) {
        await state.waitForLoad;
        return state.failLoad ? Response.json({ code: "UNAVAILABLE" }, { status: 503 }) : Response.json(state.policies);
      }
      if (request.method === "PUT" && url.pathname.includes("/access/")) {
        const body = await request.json();
        state.writes.push(body);
        if (state.failSave) return Response.json({ code: "CONFLICT" }, { status: 409 });
        state.policies[0]!.rights = MachineRights.parse(body.rights);
        return Response.json({ rights: state.policies[0]!.rights, revision: state.policies[0]!.revision });
      }
      const lang = url.searchParams.get("lang") === "de" ? "de" : "en";
      return new Response(
        `<!doctype html><html lang="${lang}" class="light" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/ui.css"><body class="k2b-ui"><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  return { server, state };
};

/** Nothing in the page or the dialog is wider than the viewport; inputs scroll their own text. */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const dialog = document.querySelector("dialog[open]");
    const wide = dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>("*"))
          .filter((element) => element.tagName !== "INPUT" && element.tagName !== "TEXTAREA")
          .filter((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === "visible")
          .map((element) => `${element.tagName.toLowerCase()}.${element.className}`)
      : ["no open dialog"];
    const panel = dialog?.getBoundingClientRect();
    return {
      page: document.documentElement.scrollWidth <= window.innerWidth,
      fits: panel ? panel.left >= 0 && panel.right <= window.innerWidth + 0.5 : false,
      wide,
    };
  });

/** Set STUDIO_SCREENSHOT_DIR to keep light screenshots of each state for a visual review. */
const shot = async (page: Page, name: string) => {
  const directory = process.env.STUDIO_SCREENSHOT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true });
};

test("Studio machine rights recover from load/save failure inside the shared access dialog", async () => {
  const { server, state } = await serve();
  state.failLoad = true;
  state.failSave = true;
  state.failSecretSave = true;
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    browser = await launchBrowser({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = pageErrors(page);
    await page.goto(server.url.href);
    const dialog = page.locator("dialog[open]");
    await dialog.getByText("Machine rights could not be loaded.", { exact: true }).waitFor();
    state.failLoad = false;
    await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
    const controls = dialog.getByRole("region", { name: "Machine execution", exact: true });
    await controls.getByText("Invoice agent", { exact: true }).waitFor();
    await controls.getByText(/Account disabled/).waitFor();
    // The Code account has a grant, but no machine rights: it acts only through its level.
    expect(await controls.getByText(/Code von/).count()).toBe(0);
    await controls
      .getByText(
        "Agents added above appear here once saved. Accounts bound only to this app are added through the API. Code service accounts get no execution rights.",
      )
      .waitFor();
    const execute = controls.getByRole("checkbox", { name: "Execute published code", exact: true }).first();
    await execute.uncheck();
    await controls.getByRole("button", { name: "Save rights", exact: true }).first().click();
    await controls.getByText(/Could not save/).waitFor();
    expect(await execute.isChecked()).toBe(false);
    state.failSave = false;
    await controls.getByRole("button", { name: "Save rights", exact: true }).first().click();
    await controls
      .getByText(/Execution is off/)
      .first()
      .waitFor();
    expect(state.writes).toHaveLength(2);
    // Machine rights save on their own: the access list has no pending change.
    await dialog.getByText("No changes", { exact: true }).waitFor();
    const secretControls = dialog.getByRole("region", { name: "App machine secrets", exact: true });
    await secretControls.getByRole("button", { name: "Add machine secret", exact: true }).click();
    await secretControls.getByLabel("Secret name", { exact: true }).fill("reportApi");
    await secretControls.getByLabel("HTTPS origin", { exact: true }).fill("https://api.example.com");
    const secretValue = secretControls.getByLabel("Secret value", { exact: true });
    await secretValue.fill("fictional-only");
    await secretControls.getByRole("button", { name: "Save secret", exact: true }).click();
    await secretControls.getByText(/Could not save/).waitFor();
    expect(await secretValue.inputValue()).toBe("fictional-only");
    state.failSecretSave = false;
    await secretControls.getByRole("button", { name: "Save secret", exact: true }).click();
    await secretControls.getByRole("button", { name: "Replace secret", exact: true }).waitFor();
    expect(await secretValue.count()).toBe(0);
    await secretControls.getByRole("button", { name: "Replace secret", exact: true }).click();
    expect(await secretValue.inputValue()).toBe("");
    await secretControls.getByRole("button", { name: "Cancel", exact: true }).click();
    await secretControls.getByLabel("Secret name", { exact: true }).waitFor({ state: "hidden" });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      // Cancel removes its hovered button; resizing can move other buttons under that pointer.
      // Park on the persistent dialog title and wait for the buttons' hover-color transitions.
      await dialog.getByRole("heading", { name: "Access to Angebotsrechner", exact: true }).hover();
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll("dialog .k2b-button")).every(
          (button) =>
            !button.matches(":hover") &&
            !button
              .getAnimations()
              .some(
                (animation) =>
                  animation.timeline === document.timeline &&
                  animation instanceof CSSTransition &&
                  (animation.transitionProperty === "background-color" || animation.transitionProperty === "color") &&
                  (animation.pending || animation.playState === "running"),
              ),
        ),
      );
      await settled(page);
      expect(await overflow(page)).toEqual({ page: true, fits: true, wide: [] });
    }
    const loading = Promise.withResolvers<void>();
    state.waitForLoad = loading.promise;
    await page.reload();
    await page.getByText("Loading machine rights…", { exact: true }).first().waitFor();
    state.policies.length = 0;
    state.secretEntries.length = 0;
    loading.resolve();
    await page
      .getByText("No agents or service accounts have access. Add one above and save, then choose its execution rights here.", {
        exact: true,
      })
      .waitFor();
    await page.reload();
    await page.getByText("No app machine secrets configured.", { exact: true }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    try {
      await browser?.close();
    } finally {
      await server.stop(true);
    }
  }
}, 60000);

for (const width of [1280, 390])
  test(`de ${width}px: a Code account gets Use by its identifier like a person, and the dialog fits`, async () => {
    const { server, state } = await serve();
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
      browser = await launchBrowser({ headless: true });
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = pageErrors(page);
      await page.goto(`${server.url.href}?lang=de`);
      const dialog = page.locator("dialog[open]");
      await dialog.getByRole("region", { name: "Maschinenausführung", exact: true }).getByText("Invoice agent", { exact: true }).waitFor();
      await settled(page);
      const services = dialog.locator("section", { has: page.locator("h3", { hasText: /^Dienstkonten/ }) });
      const code = services.locator("li", { hasText: "Code von einkauf-und-rechnungseingang@beispiel.de" });
      // A stored row reads like a new one: the server's line with its level.
      await code.getByText("Dienstkonto eines Postfachs · darf benutzen", { exact: true }).waitFor();
      await services.getByText("Wer den Code bearbeitet, handelt mit diesem Recht.").waitFor();
      // Long titles wrap instead of being cut, also on a phone, even when the app's own stylesheet repeats utilities.
      const clipped = (text: string) =>
        services
          .getByText(text, { exact: true })
          .evaluate((element) => element.scrollWidth > element.clientWidth + 1 || getComputedStyle(element).textOverflow === "ellipsis");
      expect(await clipped("Code von einkauf-und-rechnungseingang@beispiel.de")).toBe(false);
      // Agents stay with people; only Code and object accounts sit under Dienstkonten.
      expect(await services.getByText("Invoice agent").count()).toBe(0);
      await code.locator("button[aria-haspopup]").first().click();
      const options = await page.locator('[role="option"]:visible').allTextContents();
      expect(options.map((option) => option.trim())).toEqual(["Benutzen"]);
      await page.keyboard.press("Escape");
      // Scrolling moves controls under a resting pointer and starts their hover transitions; park it on the backdrop.
      await page.mouse.move(1, 1);
      for (const control of [code.locator("button[aria-haspopup]").first(), code.getByRole("button", { name: /entfernen$/ })]) {
        await control.scrollIntoViewIfNeeded();
        await settled(page);
        expect(await control.isVisible()).toBe(true);
        const box = (await control.boundingBox())!;
        expect(box.x >= 0 && box.x + box.width <= width).toBe(true);
      }
      expect(await overflow(page)).toEqual({ page: true, fits: true, wide: [] });
      const machines = dialog.getByRole("region", { name: "Maschinenausführung", exact: true });
      await machines.getByRole("heading", { name: "Maschinenausführung", exact: true }).evaluate((heading) => heading.scrollIntoView());
      await settled(page);
      await shot(page, `de-${width}-maschinenrechte`);
      await services.scrollIntoViewIfNeeded();
      await shot(page, `de-${width}-normal`);

      await services.getByRole("button", { name: "Dienstkonto hinzufügen" }).click();
      const handle = services.getByLabel("Kennung des Dienstkontos", { exact: true });
      await handle.fill("code-7k2q9m4xwt");
      await services.getByText("Code von info@beispiel.de", { exact: true }).waitFor();
      // The sheet brings the field and its hit into view itself.
      expect(
        await handle.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return box.top >= 0 && box.bottom <= window.innerHeight;
        }),
      ).toBe(true);
      expect(await clipped("Code von info@beispiel.de")).toBe(false);
      expect(state.lookups.some((search) => /target_type=assistant\.app/.test(search) && /target_id=App234/.test(search))).toBe(true);
      await settled(page);
      expect(await overflow(page)).toEqual({ page: true, fits: true, wide: [] });
      await shot(page, `de-${width}-dienst-hinzu`);

      await services.locator("li button", { hasText: "Code von info@beispiel.de" }).click();
      const added = services.locator("li", { hasText: "Code von info@beispiel.de" });
      await added.getByText("Neu", { exact: true }).first().waitFor();
      await dialog.getByText("1 Änderung", { exact: true }).waitFor();
      await settled(page);
      expect(await overflow(page)).toEqual({ page: true, fits: true, wide: [] });
      await shot(page, `de-${width}-dienst-neu`);

      await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      expect(await page.evaluate(() => (window as unknown as { studioAccessCalls: string[] }).studioAccessCalls)).toEqual([
        "grant service_account read",
      ]);
      expect(errors).toEqual([]);
    } finally {
      try {
        await browser?.close();
      } finally {
        await server.stop(true);
      }
    }
  }, 60000);
