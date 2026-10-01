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
const { FilterChip } = await import("../actions/FilterChip");
const { Toolbar } = await import("../actions/Toolbar");
const { Tooltip } = await import("../feedback/Tooltip");
const { default: PdfPreview } = await import("../content/PdfPreview");
const { default: DetailPanel } = await import("../layout/DetailPanel");
const { default: Select } = await import("../inputs/Select");
const { SettingsGroup } = await import("../layout/Settings");
const { default: SettingsModal } = await import("../layout/SettingsModal");
const { Chat } = await import("../chat");
const { ProgressRing } = await import("../surfaces/ProgressRing");

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
 * the pixels they take, keyed by owner and taker. Every pixel counts, the
 * outermost ring included: a browser can resolve a tap on the last pixel
 * before an edge to the box behind that edge, so a hit area that merely
 * touches a control takes a one-pixel strip from it.
 */
const takenPixels = async (markup: string, width = "22rem", script = "") => {
  const page = await browser.newPage(phone);
  try {
    await page.setContent(
      phonePage(
        `<main style="width:${width};padding:2rem">${markup}</main>`,
        `<style id="without-hit-areas">.k2b-ui :is(.k2b-button, .k2b-toast__action, .k2b-toast__close, .k2b-chat-context)::after { content: none !important; }</style>`,
      ),
    );
    if (script) await runToasts(page, script);
    return await page.evaluate(() => {
      const controls = "button, a[href], input, textarea";
      const name = (element: Element | null) =>
        element ? (element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName) : "nothing";
      const tap = (x: number, y: number) => document.elementFromPoint(x, y)?.closest(controls) ?? null;
      const owned: [Element, number, number][] = [];
      for (const control of Array.from(document.querySelectorAll(controls))) {
        const box = control.getBoundingClientRect();
        for (let x = Math.floor(box.left); x < box.right; x += 1) {
          for (let y = Math.floor(box.top); y < box.bottom; y += 1) {
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

  test("keep a header meta action's edge above the DetailPanel primary actions", async () => {
    // Files details: the copy-reference action sits in the meta line, right above the favourite and download actions.
    const markup = html(() =>
      createComponent(DetailPanel.Header, {
        icon: "ti ti-file",
        title: "Flyer.pdf",
        subtitle: "PDF · 45 KB",
        get meta() {
          return createComponent(Tooltip.Anchor, {
            content: "Copy reference",
            get children() {
              return createComponent(IconButton, { label: "Copy reference", size: "xs", variant: "ghost", children: "⧉" });
            },
          });
        },
        get actions() {
          return icon("Close panel");
        },
        get primaryActions() {
          return [text("Preview"), text("Download"), anchored("Favorite")];
        },
      }),
    );
    expect(await takenPixels(markup)).toEqual({});
  });

  test("keep every edge when the PdfPreview actions wrap", async () => {
    // A failed preview adds the retry action, which wraps below the open and download actions in a narrow panel.
    const markup = html(() =>
      createComponent(PdfPreview, {
        request: async () => new Blob(),
        openHref: "/files/flyer.pdf",
        openButtonLabel: "Open in new tab",
        buttonLabel: "Try again",
        onDownload: () => {},
        children: (parts) => [parts.actions, parts.content],
      }),
    );
    expect(await takenPixels(markup, "16rem")).toEqual({});
  });

  test("give stacked DetailPanel.Action rows a 44 px row on touch that keeps its neighbours' and the section header's edges", async () => {
    const section = html(() =>
      createComponent(DetailPanel.Section, {
        title: "Actions",
        get actions() {
          return icon("Add action");
        },
        get children() {
          return [
            createComponent(DetailPanel.Action, { title: "Open in new tab", leading: "↗" }),
            createComponent(DetailPanel.Action, { title: "Version 3", description: "Fixed dates · Ana", trailing: "45 KB" }),
            createComponent(DetailPanel.Action, {
              title: "Move",
              menuItems: [{ label: "Copy", action: () => {} }],
              menuLabel: "More for Move",
            }),
            createComponent(DetailPanel.Action, {
              title: "Delete",
              secondaryAction: { label: "Remove now", icon: "ti ti-trash", onClick: () => {} },
            }),
            createComponent(DetailPanel.Action, { title: "Rename" }),
          ];
        },
      }),
    );
    // Grids and Spaces stack their rows flush; Files keeps 0.25rem between them.
    const filesColumn = `<style>.k2b-detail-panel__section-body{display:flex;flex-direction:column;gap:0.25rem}</style>`;
    expect(await takenPixels(section)).toEqual({});
    expect(await takenPixels(filesColumn + section)).toEqual({});

    const heights = async (options: typeof phone | { viewport: { width: number; height: number } }) => {
      const page = await browser.newPage(options);
      try {
        await page.setContent(phonePage(`<main style="width:22rem;padding:2rem">${section}</main>`));
        return await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>(".k2b-detail-panel__section-body .k2b-button")).map((control) => {
            const box = control.getBoundingClientRect();
            const reaches = (y: number) => document.elementFromPoint(box.left + box.width / 2, y)?.closest("a, button") === control;
            // 21 px from the centre up and down: at least 42 px, which a 31 px row never reaches.
            const midY = box.top + box.height / 2;
            return [
              control.getAttribute("aria-label") ?? control.textContent?.trim(),
              Math.round(box.height),
              reaches(midY - 21) && reaches(midY + 21),
            ];
          }),
        );
      } finally {
        await page.close();
      }
    };
    expect(await heights(phone)).toEqual([
      ["↗Open in new tab", 44, true],
      ["Version 3Fixed dates · Ana45 KB", 46, true],
      ["Move", 44, true],
      ["More for Move", 44, true],
      ["Delete", 44, true],
      ["Remove now", 44, true],
      ["Rename", 44, true],
    ]);
    // A device without a touch screen keeps the compact rows.
    expect((await heights({ viewport: { width: 1280, height: 800 } })).map(([, height]) => height)).toEqual([30, 46, 30, 28, 30, 28, 30]);
  });

  test("give stacked Dropdown items, FilterChip options, and Select options a 44 px row on touch that keeps its neighbours' edges", async () => {
    // A row menu with every item kind, the language menu of a public page, an active FilterChip with its
    // single- and multi-select sections and Clear action, and a Select with and without descriptions.
    const dropdown = html(() =>
      createComponent(Dropdown.Root, {
        label: "Row actions",
        items: [
          { label: "Rename", icon: "ti ti-pencil", action: () => {} },
          { label: "Open", href: "/files/flyer.pdf" },
          { label: "Share", description: "Anyone with the link", action: () => {} },
          { label: "Show archived", choice: "checkbox", checked: false, action: () => {} },
          {
            sectionLabel: "Language",
            items: [
              { label: "English", choice: "radio", checked: true, action: () => {} },
              { label: "Deutsch", choice: "radio", checked: false, action: () => {} },
            ],
          },
          { label: "Delete", variant: "danger", action: () => {} },
        ],
        get children() {
          return createComponent(Dropdown.Trigger, { children: "Actions" });
        },
      }),
    );
    const filters = html(() =>
      createComponent(FilterChip, {
        label: "Filter",
        icon: "ti ti-filter",
        value: ["open"],
        onValueChange: () => {},
        options: [
          {
            label: "Status",
            options: [
              { value: "open", label: "Open", icon: "ti ti-circle" },
              { value: "done", label: "Done", icon: "ti ti-check" },
            ],
          },
          {
            label: "Tags",
            multiple: true,
            options: [
              { value: "urgent", label: "Urgent", color: "#ef4444" },
              { value: "ui", label: "UI", color: "#14b8a6" },
            ],
          },
        ],
      }),
    );
    const select = html(() =>
      createComponent(Select, {
        label: "Status",
        value: null,
        options: [
          { value: "open", label: "Open" },
          { value: "done", label: "Done", description: "Closed and archived" },
        ],
      }),
    );

    const rows = async (markup: string, options: typeof phone | { viewport: { width: number; height: number } }) => {
      const page = await browser.newPage(options);
      try {
        await page.setContent(phonePage(`<main style="width:22rem;padding:2rem">${markup}</main>`));
        return await page.evaluate(() => {
          document.querySelector<HTMLElement>("[popover]")!.showPopover();
          const items = Array.from(document.querySelectorAll<HTMLElement>(".k2b-dropdown__item, .k2b-choice-option"));
          return items.map((item, index) => {
            const box = item.getBoundingClientRect();
            const reaches = (y: number) => document.elementFromPoint(box.left + box.width / 2, y)?.closest("a, button") === item;
            const previous = items[index - 1]?.getBoundingClientRect();
            // A tap on the item's own first and last pixel row reaches it, and no item reaches into the one before it.
            return [
              item.textContent?.trim(),
              Math.round(box.height),
              reaches(box.top + 1) && reaches(box.bottom - 1),
              !previous || previous.bottom <= box.top,
            ];
          });
        });
      } finally {
        await page.close();
      }
    };
    expect(await rows(dropdown, phone)).toEqual([
      ["Rename", 44, true, true],
      ["Open", 44, true, true],
      ["ShareAnyone with the link", 47, true, true],
      ["Show archived", 44, true, true],
      ["English", 44, true, true],
      ["Deutsch", 44, true, true],
      ["Delete", 44, true, true],
    ]);
    expect(await rows(filters, phone)).toEqual([
      ["Open", 44, true, true],
      ["Done", 44, true, true],
      ["Urgent", 44, true, true],
      ["UI", 44, true, true],
      ["Clear", 44, true, true],
    ]);
    expect(await rows(select, phone)).toEqual([
      ["Open", 44, true, true],
      ["DoneClosed and archived", 50, true, true],
    ]);
    // A device without a touch screen keeps the compact rows.
    const desktop = { viewport: { width: 1280, height: 800 } };
    expect((await rows(dropdown, desktop)).map(([, height]) => height)).toEqual([32, 32, 47, 32, 32, 32, 32]);
    expect((await rows(filters, desktop)).map(([, height]) => height)).toEqual([32, 32, 32, 32, 32]);
    expect((await rows(select, desktop)).map(([, height]) => height)).toEqual([32, 50]);
  });

  test("keep a field's edge before a compact button, and after one at the documented 0.625rem", async () => {
    const row = (gap: string, content: string) => `<div style="display:flex;gap:${gap};align-items:center">${content}</div>`;
    const field = `<input aria-label="Search" style="height:1.75rem;width:10rem">`;
    const button = html(() => icon("Go"));
    expect(await takenPixels(row("0.25rem", field + button))).toEqual({});
    expect(await takenPixels(row("0.625rem", button + field))).toEqual({});
  });

  test("keep the message field's edge above the chat composer footer, and one trigger box for every context state", async () => {
    // The Assistant's composer: add menu, model, usage indicator, context usage, dictation, and send.
    const composer = (details: string) =>
      html(() =>
        createComponent(Chat.Composer, {
          value: "",
          onValueChange: () => {},
          onSubmit: () => {},
          fileSelection: { onSelect: () => {} },
          models: [{ id: "a", label: "Model A" }],
          selectedModelId: "a",
          onModelChange: () => {},
          modelDetails: "%details%",
          contextUsage: { usage: { input: 1200, output: 20 }, contextWindow: 128_000 },
          get submitTools() {
            return icon("Dictate");
          },
        }),
      ).replace("%details%", details);
    const popup = (trigger: string) =>
      html(() => createComponent(Chat.ContextPopup, { "aria-label": "Usage", content: "Usage", children: "%trigger%" })).replace(
        "%trigger%",
        trigger,
      );
    const dashed = `<i class="ti ti-circle-dashed" aria-hidden="true"></i>`;
    // A reading, a missing or failed reading, unlimited usage, and the placeholder before the first reading.
    const states = [
      popup(html(() => createComponent(ProgressRing, { value: 92, tone: "warning" }))),
      popup(dashed),
      popup(`<i class="ti ti-infinity" aria-hidden="true"></i>`),
      `<span class="k2b-chat-context" aria-hidden="true">${dashed}</span>`,
    ].map(composer);
    for (const markup of states) expect(await takenPixels(markup)).toEqual({});

    const page = await browser.newPage(phone);
    try {
      const boxes: number[][] = [];
      for (const markup of states) {
        await page.setContent(phonePage(`<main style="width:22rem;padding:2rem">${markup}</main>`));
        boxes.push(
          await page.evaluate(() => {
            const box = document.querySelector(".k2b-chat-composer__tools .k2b-chat-context")!.getBoundingClientRect();
            const footer = document.querySelector(".k2b-chat-composer__footer")!.getBoundingClientRect();
            return [box.left, box.top, box.width, box.height, footer.height];
          }),
        );
      }
      expect(new Set(boxes.map((box) => box.join())).size).toBe(1);
    } finally {
      await page.close();
    }
  });

  test("give a toast's action and close button 44 px hit areas that keep each other's and the next toast's edges", async () => {
    // A phone shows two toasts at once. "Neu laden" after a notebook session expiry, a one-line "OK" right before the
    // close button, and a toast with a progress bar, where only the close button dismisses.
    const reload = `toast("Live updates need a new sign-in.", { title: "Session expired", duration: 0, action: { label: "Reload", onClick: () => {} } });`;
    const ok = `toast("Saved.", { duration: 0, action: { label: "OK", href: "#ok" } });`;
    const progress = `toast("500 / 1000 records saved", { title: "Import", progress: 0.5, action: { label: "Cancel", onClick: () => {} } });`;
    const close = ["Dismiss notification", true, true, true, true];
    for (const [toasts, labels] of [
      [`${reload}\n${ok}`, ["Reload", "OK"]],
      [`${ok}\n${progress}`, ["OK", "Cancel"]],
    ] as const) {
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
        expect(reach).toEqual(labels.flatMap((label) => [[label, true, true, true, true], close]));
      } finally {
        await page.close();
      }
    }
  });

  test("keep the rail open below the last toast for its shadow, and order a titled progress toast like the upload panel", async () => {
    const page = await browser.newPage(phone);
    try {
      await page.setContent(phonePage("<main></main>"));
      await runToasts(
        page,
        `toast("6 of 12 files", { title: "Exporting archive", progress: 0.5, action: { label: "Cancel", onClick: () => {} } });`,
      );
      const layout = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const [rail, card, title, bar, summary, action, close] = [
          "[data-k2b-toast-container]",
          ".k2b-toast",
          ".k2b-toast__title",
          ".k2b-toast__progress",
          ".k2b-toast__description",
          ".k2b-toast__action",
          ".k2b-toast__close",
        ].map(box);
        return {
          // The rail scrolls and so clips; the toast shadow reaches 24 px below the card in the dark theme.
          shadowRoom: rail!.bottom - card!.bottom >= 24,
          order: title!.bottom <= bar!.top && bar!.bottom <= summary!.top,
          actionOnSummaryLine: action!.top >= bar!.bottom && action!.right === close!.right,
          barUnderCloseColumn: bar!.right > close!.left,
          tabular: getComputedStyle(document.querySelector(".k2b-toast__description")!).fontVariantNumeric,
        };
      });
      expect(layout).toEqual({
        shadowRoom: true,
        order: true,
        actionOnSummaryLine: true,
        barUnderCloseColumn: true,
        tabular: "tabular-nums",
      });
    } finally {
      await page.close();
    }
  });
});

describe("@k2b/ui Calendar on a phone", () => {
  const phoneCalendar = async (view: "month" | "mobile-month") => {
    const { default: Calendar } = await import("../content/Calendar");
    return html(() =>
      createComponent(Calendar, {
        date: "2026-09-29",
        view,
        views: ["day", "week", "month"],
        dateConfig: { timeZone: "Europe/Berlin", weekStartsOn: 1 },
        events: [{ id: "shift", title: "Counter", start: "2026-09-29T08:00:00Z", end: "2026-09-29T12:00:00Z" }],
        getDateHref: (date: Date) => `/calendar?date=${date.toISOString().slice(0, 10)}`,
        getViewHref: (next: string) => `/calendar?view=${next}`,
        getEventHref: () => "/calendar?event=shift",
      }),
    );
  };

  test("give previous and next a 44 px tall hit area without taking each other's pixels", async () => {
    const markup = await phoneCalendar("month");
    // The header alone: scanning every day link of the grid pixel by pixel would take far longer.
    const header = markup.match(/<header class="k2b-calendar-header"[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(await takenPixels(`<section class="k2b-content-calendar">${header}</section>`, "22rem")).toEqual({});

    const page = await browser.newPage(phone);
    try {
      await page.setContent(phonePage(`<main style="width:22rem;padding:2rem">${markup}</main>`));
      const reach = await page.evaluate(() => {
        const [previous, next] = Array.from(document.querySelectorAll<HTMLElement>(".k2b-calendar-header__nav-button"));
        const reaches = (control: HTMLElement, x: number, y: number) => document.elementFromPoint(x, y)?.closest("a, button") === control;
        const around = (control: HTMLElement) => {
          const box = control.getBoundingClientRect();
          const midX = box.left + box.width / 2;
          const midY = box.top + box.height / 2;
          // 21 px up and down, which only the 2.75rem hit area reaches from a 1.75rem button.
          return [reaches(control, midX, midY - 21), reaches(control, midX, midY + 21), reaches(control, box.right + 7, midY)];
        };
        return { previous: around(previous!), next: around(next!) };
      });
      expect(reach).toEqual({ previous: [true, true, false], next: [true, true, true] });
    } finally {
      await page.close();
    }
  });

  test("keep the mobile month grid compact with finger-sized days, so the agenda follows close below", async () => {
    const page = await browser.newPage(phone);
    try {
      await page.setContent(phonePage(`<main style="width:24.375rem">${await phoneCalendar("mobile-month")}</main>`));
      const layout = await page.evaluate(() => {
        const days = Array.from(document.querySelectorAll(".k2b-calendar-month__week")).map((week) => week.getBoundingClientRect().height);
        const grid = document.querySelector(".k2b-calendar-month")!.getBoundingClientRect();
        const agenda = document.querySelector(".k2b-calendar-mobile-month__agenda")!.getBoundingClientRect();
        return { shortest: Math.min(...days), tallest: Math.max(...days), grid: grid.height, gap: agenda.top - grid.bottom };
      });
      expect(layout.shortest).toBeGreaterThanOrEqual(44);
      expect(layout.tallest).toBeLessThanOrEqual(52);
      // Six weeks and the weekday row, instead of the month view's 36rem.
      expect(layout.grid).toBeLessThan(360);
      expect(layout.gap).toBeLessThanOrEqual(24);
    } finally {
      await page.close();
    }
  });
});
