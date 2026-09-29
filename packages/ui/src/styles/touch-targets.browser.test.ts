import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { type Browser, chromium, type Page } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";

// Which control a tap reaches depends on layout and paint order, which
// happy-dom does not model, so a real engine renders the shipped stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-touch-targets-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Button, IconButton } = await import("../actions/Button");
const { Dropdown } = await import("../actions/Dropdown");
const { Toolbar } = await import("../actions/Toolbar");
const { Tooltip } = await import("../feedback/Tooltip");
const { default: DetailPanel } = await import("../layout/DetailPanel");
const { SettingsGroup } = await import("../layout/Settings");
const { default: SettingsModal } = await import("../layout/SettingsModal");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
// `toast` builds its DOM in the browser, so the page runs the real module.
const toastEntry = resolve(root, "toast-entry.ts");
await Bun.write(
  toastEntry,
  `import { toast } from ${JSON.stringify(resolve(import.meta.dir, "../feedback/toast"))};\nObject.assign(globalThis, { toast });\n`,
);
const toastBuild = await Bun.build({ entrypoints: [toastEntry], target: "browser", format: "iife" });
if (!toastBuild.success) throw new AggregateError(toastBuild.logs, "Could not bundle toast for the browser.");
const toastScript = await toastBuild.outputs[0]!.text();
const phone = { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const icon = (label: string) => createComponent(IconButton, { label, size: "sm", variant: "ghost", children: "×" });
const text = (label: string) => createComponent(Button, { size: "sm", variant: "secondary", children: label });
const menu = (label: string) =>
  createComponent(Dropdown.Root, {
    items: [{ label: "Export", action: () => {} }],
    get children() {
      return createComponent(Dropdown.Trigger, { iconOnly: true, size: "sm", variant: "ghost", label, children: "…" });
    },
  });
const anchored = (label: string) =>
  createComponent(Tooltip.Anchor, {
    content: label,
    get children() {
      return icon(label);
    },
  });
const html = (view: () => JSX.Element) => renderToString(view);
// @k2b/ssr wraps every island in one of these and ships this rule with the page.
const island = (markup: string) => `<solid-island>${markup}</solid-island>`;
const phonePage = (body: string, head = "") =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
  `<style>solid-client,solid-island{display:contents}</style>${head}</head>` +
  `<body class="k2b-ui">${body}</body></html>`;

/**
 * Renders the markup on a phone and taps every pixel that reaches a control
 * when the touch hit areas are switched off. The hit areas may add pixels to
 * a control but must never take one from another control; the result lists
 * the pixels they take, keyed by owner and taker. Chromium resolves a point
 * less than a pixel before an edge to the box behind that edge, so each
 * control's outermost pixel ring is left out: two areas that only touch do
 * not count as taking.
 */
const takenPixels = async (markup: string, width = "22rem", script = "") => {
  const page = await browser.newPage(phone);
  try {
    await page.setContent(
      phonePage(
        `<main style="width:${width};padding:2rem">${markup}</main>`,
        `<style id="without-hit-areas">.k2b-ui :is(.k2b-button, .k2b-toast__action, .k2b-toast__close)::after { content: none !important; }</style>`,
      ),
    );
    if (script) await runToasts(page, script);
    return await page.evaluate(() => {
      const controls = "button, a[href], input";
      const name = (element: Element | null) =>
        element ? (element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName) : "nothing";
      const tap = (x: number, y: number) => document.elementFromPoint(x, y)?.closest(controls) ?? null;
      const owned: [Element, number, number][] = [];
      for (const control of Array.from(document.querySelectorAll(controls))) {
        const box = control.getBoundingClientRect();
        for (let x = Math.ceil(box.left) + 1; x + 2 <= box.right; x += 1) {
          for (let y = Math.ceil(box.top) + 1; y + 2 <= box.bottom; y += 1) {
            if (tap(x + 0.5, y + 0.5) === control) owned.push([control, x + 0.5, y + 0.5]);
          }
        }
      }
      if (owned.length === 0) throw new Error("No control rendered a tappable pixel.");
      document.getElementById("without-hit-areas")?.remove();
      const taken: Record<string, number> = {};
      for (const [control, x, y] of owned) {
        const hit = tap(x, y);
        if (hit === control) continue;
        const key = `${name(control)} -> ${name(hit)}`;
        taken[key] = (taken[key] ?? 0) + 1;
      }
      return taken;
    });
  } finally {
    await page.close();
  }
};

/** Shows toasts through the real `toast` module and waits until every one has settled in the rail. */
const runToasts = async (page: Page, script: string) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addScriptTag({ content: `${toastScript}\n${script}` });
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".k2b-toast")).every((toast) => toast.getAttribute("data-open") === "true"),
  );
};

describe("@k2b/ui touch hit areas on a phone", () => {
  test("give a lone compact button a 44 px square without changing its visible size", async () => {
    const page = await browser.newPage(phone);
    try {
      await page.setContent(phonePage(`<main style="padding:3rem">${html(() => icon("Close"))}</main>`));
      const reach = await page.evaluate(() => {
        const button = document.querySelector("button")!;
        const box = button.getBoundingClientRect();
        const reaches = (x: number, y: number) => document.elementFromPoint(x, y)?.closest("button") === button;
        const midX = box.left + box.width / 2;
        const midY = box.top + box.height / 2;
        // (44 - 28) / 2 = 8 px beyond each edge; probe well inside and well outside that line.
        const around = (distance: number) => [
          reaches(box.left - distance, midY),
          reaches(box.right + distance, midY),
          reaches(midX, box.top - distance),
          reaches(midX, box.bottom + distance),
        ];
        return { visible: [box.width, box.height], at7px: around(7), at10px: around(10) };
      });
      expect(reach).toEqual({ visible: [28, 28], at7px: [true, true, true, true], at10px: [false, false, false, false] });
    } finally {
      await page.close();
    }
  });

  test("keep a header action's edge when the next action sits in a Dropdown or Tooltip.Anchor", async () => {
    // Grids and Contacts detail headers: a favourite button, the record menu, and the close button.
    const markup = html(() =>
      createComponent(DetailPanel.Header, {
        title: "Record",
        get actions() {
          return [
            createComponent(Button, { size: "sm", variant: "ghost", tooltip: "Favorite", children: "★" }),
            menu("More actions"),
            anchored("Close panel"),
          ];
        },
      }),
    );
    expect(await takenPixels(markup)).toEqual({});
  });

  test("keep a header action's edge when every action is its own island", async () => {
    // Cloud's phone header: Help, Search, and Apps each hydrate as a separate island.
    const row = [icon("Help"), icon("Search"), icon("Apps")].map((button) => island(html(() => button))).join("");
    const wrapped = [menu("More actions"), anchored("Close panel")].map((control) => island(html(() => control))).join("");
    const inRow = (markup: string) => `<div style="display:flex;gap:0.25rem;align-items:center">${markup}</div>`;
    expect(await takenPixels(inRow(row))).toEqual({});
    expect(await takenPixels(inRow(island(html(() => icon("Back"))) + wrapped))).toEqual({});
  });

  test("give the SettingsModal close a 44 px hit area that keeps the category row's edges", async () => {
    const modal = (titles: string[]) =>
      `<div style="height:30rem">${html(() =>
        createComponent(SettingsModal, {
          title: "Base settings",
          onClose: () => {},
          get children() {
            return titles.map((title) => createComponent(SettingsModal.Tab, { id: title.toLowerCase(), title, children: title }));
          },
        }),
      )}</div>`;
    // The close comes first in the DOM, but a category row that scrolls under its hit area keeps every visible tab pixel.
    expect(await takenPixels(modal(["General", "Fields", "Access", "Automations", "Danger"]))).toEqual({});

    const page = await browser.newPage(phone);
    try {
      await page.setContent(phonePage(`<main style="width:22rem;padding:2rem">${modal(["General"])}</main>`));
      const reach = await page.evaluate(() => {
        const close = document.querySelector<HTMLElement>(".k2b-settings__close")!;
        const box = close.getBoundingClientRect();
        const reaches = (x: number, y: number) => document.elementFromPoint(x, y)?.closest("button") === close;
        const midX = box.left + box.width / 2;
        const midY = box.top + box.height / 2;
        // 21 px from the centre in every direction: at least 42 px, which only the 2.75rem hit area reaches.
        return [reaches(midX - 21, midY), reaches(midX + 21, midY), reaches(midX, midY - 21), reaches(midX, midY + 21)];
      });
      expect(reach).toEqual([true, true, true, true]);
    } finally {
      await page.close();
    }
  });

  test("keep every edge in wrapped primary actions, settings actions, and a wrapped toolbar", async () => {
    const actions = html(() =>
      createComponent(DetailPanel.Header, {
        title: "Record",
        get primaryActions() {
          return [text("Open file"), text("Download"), text("Share link"), text("Move to"), text("Delete")];
        },
      }),
    );
    const toolbar = html(() =>
      createComponent(Toolbar, {
        label: "Formatting",
        wrap: true,
        get children() {
          return [
            createComponent(Toolbar.Group, {
              get children() {
                return [icon("Bold"), icon("Italic"), icon("Underline")];
              },
            }),
            createComponent(Toolbar.Separator, {}),
            createComponent(Toolbar.Group, {
              get children() {
                return [icon("List"), icon("Quote"), icon("Code")];
              },
            }),
          ];
        },
      }),
    );
    const settings = html(() =>
      createComponent(SettingsGroup, {
        title: "Members",
        get children() {
          return createComponent(SettingsGroup.Action, {
            get children() {
              return [text("Invite"), text("Import"), text("Export list"), text("Remove all")];
            },
          });
        },
      }),
    );
    expect(await takenPixels(actions, "14rem")).toEqual({});
    expect(await takenPixels(settings, "14rem")).toEqual({});
    expect(await takenPixels(toolbar, "9rem")).toEqual({});
  });

  test("keep stacked DetailPanel.Action rows and their section header apart", async () => {
    const markup = html(() =>
      createComponent(DetailPanel.Section, {
        title: "Actions",
        get actions() {
          return icon("Add action");
        },
        get children() {
          return [
            createComponent(DetailPanel.Action, { title: "Rename" }),
            createComponent(DetailPanel.Action, {
              title: "Move",
              menuItems: [{ label: "Copy", action: () => {} }],
              menuLabel: "More for Move",
            }),
            createComponent(DetailPanel.Action, {
              title: "Delete",
              secondaryAction: { label: "Remove now", icon: "ti ti-trash", onClick: () => {} },
            }),
          ];
        },
      }),
    );
    expect(await takenPixels(markup)).toEqual({});
  });

  test("keep a field's edge before a compact button, and after one at the documented 0.5rem", async () => {
    const row = (gap: string, content: string) => `<div style="display:flex;gap:${gap};align-items:center">${content}</div>`;
    const field = `<input aria-label="Search" style="height:1.75rem;width:10rem">`;
    const button = html(() => icon("Go"));
    expect(await takenPixels(row("0.25rem", field + button))).toEqual({});
    expect(await takenPixels(row("0.5rem", button + field))).toEqual({});
  });

  test("give a toast's action and close button 44 px hit areas that keep each other's and the next toast's edges", async () => {
    // "Neu laden" after a notebook session expiry, a short "OK", and a toast with a progress bar, where only the close button dismisses.
    const toasts = `
      toast("Live updates need a new sign-in.", { title: "Session expired", duration: 0, action: { label: "Reload", onClick: () => {} } });
      toast("Saved.", { duration: 0, action: { label: "OK", href: "#ok" } });
      toast("500 / 1000 records saved", { title: "Import", progress: 0.5, action: { label: "Cancel", onClick: () => {} } });
    `;
    expect(await takenPixels("", "22rem", toasts)).toEqual({});

    const page = await browser.newPage(phone);
    try {
      await page.setContent(phonePage("<main></main>"));
      await runToasts(page, toasts);
      const reach = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".k2b-toast__action, .k2b-toast__close")).map((control) => {
          const box = control.getBoundingClientRect();
          const reaches = (x: number, y: number) => document.elementFromPoint(x, y)?.closest("a, button") === control;
          const midX = box.left + box.width / 2;
          const midY = box.top + box.height / 2;
          // 21 px from the centre in every direction: at least 42 px, which only the 2.75rem hit area reaches.
          return [
            control.getAttribute("aria-label") ?? control.textContent,
            reaches(midX - 21, midY),
            reaches(midX + 21, midY),
            reaches(midX, midY - 21),
            reaches(midX, midY + 21),
          ];
        }),
      );
      const close = ["Dismiss notification", true, true, true, true];
      expect(reach).toEqual([
        ["Reload", true, true, true, true],
        close,
        ["OK", true, true, true, true],
        close,
        ["Cancel", true, true, true, true],
        close,
      ]);
    } finally {
      await page.close();
    }
  });
});
