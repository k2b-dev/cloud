import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page, Route } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// A command's image, such as a marketplace logo, sits in the same slot as an icon or an avatar: its box has its size
// before the image arrives, every label starts on one line, and a pair of images follows the theme. The slash list
// docks to its composer: as wide as it, just above it, or below it near the top, and the composer does not move.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "slash-geometry.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { CommandMenu, MarkdownEditor, SlashCommands } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const avatar = () => {
  const span = document.createElement("span");
  span.textContent = "MB";
  span.style.cssText = "display:grid;place-items:center;width:20px;height:20px;border-radius:99px;font-size:9px";
  return span;
};
const composer = document.getElementById("composer");
globalThis.assigned = [];
const names = ["Lea Krüger", "Valentin Brandt", "Mara Brandt"];
// "#report" lets a person confirm the assignment and adds a command that fails, so the outcome line shows.
const report = location.hash === "#report";
const entries = () => names.map((name) => ({ label: name, onSelect: (context) => {
  globalThis.assigned.push({ name, path: context.path.map((item) => item.label), text: context.text });
  if (report) context.success(name + " zugewiesen");
} }));
// "#slow" answers each search after a while, as a server would.
const people = location.hash === "#slow" ? () => new Promise((resolve) => setTimeout(() => resolve(entries()), 400)) : entries();
const [textarea, setTextarea] = createSignal();
render(
  () => [
    createComponent(MarkdownEditor, { "aria-label": "Nachricht", variant: "embedded", noToolbar: true, showStats: false, lines: 3, textareaRef: setTextarea }),
    createComponent(SlashCommands, { get textarea() { return textarea(); }, composer, items: [
      { label: "Telefonat", description: "Anruf festhalten", icon: "ti ti-phone", onSelect: () => {} },
      { label: "Zuweisen", description: "Person und Rolle", icon: "ti ti-user-plus", next: { label: "Person suchen", items: people } },
      ...(report ? [{ label: "Kunstbörse", onSelect: () => Promise.reject(new Error("Kunstbörse ist nicht erreichbar")) }] : []),
    ] }),
  ],
  composer,
);
render(
  () =>
    createComponent(CommandMenu, {
      label: "Hinzufügen",
      search: "Befehle suchen",
      items: [
        { label: "Telefonat", icon: "ti ti-phone", onSelect: () => {} },
        { label: "Trödelplatz", image: "/logo/slow.svg", onSelect: () => {} },
        { label: "Antikmarkt", image: { light: "/logo/light.svg", dark: "/logo/dark.svg" }, onSelect: () => {} },
        { label: "Mara Brandt", leading: avatar, onSelect: () => {} },
        // The first try fails; Retry waits until the test releases it.
        ...(report ? [{ label: "Kunstbörse", onSelect: () => {
          globalThis.tries = (globalThis.tries ?? 0) + 1;
          return globalThis.tries === 1
            ? Promise.reject(new Error("Kunstbörse ist nicht erreichbar"))
            : new Promise((resolve) => { globalThis.releaseRetry = resolve; });
        } }] : []),
      ],
      get children() {
        return createComponent(CommandMenu.Trigger, { label: "Hinzufügen", children: "+" });
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the command image fixture for the browser.");
const script = await build.outputs[0]!.text();
const logo = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${color}"/></svg>`;

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** Loads the menu; the slow logo answers only when the test releases it. */
const load = async (theme?: "dark", composerAt: "top" | "bottom" = "bottom", hash = "") => {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  let release!: () => void;
  const slow = new Promise<void>((done) => {
    release = done;
  });
  await page.route("http://image.test/logo/**", async (route: Route) => {
    const name = new URL(route.request().url()).pathname;
    if (name.endsWith("slow.svg")) await slow;
    await route.fulfill({ contentType: "image/svg+xml", body: logo(name.endsWith("dark.svg") ? "#f4f4f5" : "#0f766e") });
  });
  const html =
    `<!doctype html><html><head><style>${css}</style></head>` +
    `<body class="k2b-ui"${theme ? ` data-theme="${theme}"` : ""} style="margin:0"><main id="app" style="padding:24px"></main>` +
    `<div id="composer" style="position:fixed;left:120px;width:520px;${composerAt === "top" ? "top:16px" : "bottom:16px"};border:2px solid #ccc;padding:4px"></div></body></html>`;
  await page.route("http://image.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`http://image.test/${hash}`);
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Hinzufügen" }).click();
  await page.getByRole("option", { name: /Telefonat/ }).waitFor();
  return { page, release };
};

/** The box of the row's leading slot, its image if any, and where its label starts. */
const geometry = (page: Page, label: string) =>
  page.evaluate((label) => {
    const row = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((option) => option.textContent?.includes(label))!;
    const slot = row.firstElementChild!.getBoundingClientRect();
    const image = [...row.querySelectorAll<HTMLImageElement>(".k2b-command-list__image > img")].find(
      (img) => getComputedStyle(img).display !== "none",
    );
    const box = image?.getBoundingClientRect();
    return {
      slot: { width: slot.width, height: slot.height },
      image: box ? { width: box.width, height: box.height, src: image!.getAttribute("src"), alt: image!.getAttribute("alt") } : null,
      label: row.querySelector(".k2b-dropdown__copy")!.getBoundingClientRect().left,
      row: row.getBoundingClientRect().height,
    };
  }, label);

/** The boxes of the composer and of the docked slash list, after typing `/` in the composer. */
const docked = async (page: Page) => {
  const composer = () =>
    page.evaluate(() => {
      const rect = document.getElementById("composer")!.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, bottom: rect.bottom };
    });
  const before = await composer();
  await page.getByRole("textbox", { name: "Nachricht" }).click();
  await page.keyboard.type("/");
  await page.locator(".k2b-autocomplete__options[data-commands]").waitFor();
  await settled(page);
  const list = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".k2b-autocomplete__options[data-commands]")!;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, bottom: rect.bottom, side: element.dataset.docked };
  });
  return { before, after: await composer(), list };
};

describe("docked slash list", () => {
  test("it docks above the composer at its full width and leaves the composer where it was", async () => {
    const { page, release } = await load();
    try {
      const { before, after, list } = await docked(page);
      expect(after).toEqual(before);
      expect(list.side).toBe("above");
      expect(list.left).toBe(before.left);
      expect(list.width).toBe(before.width);
      expect(before.top - list.bottom).toBe(6);
    } finally {
      release();
      await page.close();
    }
  });

  test("near the top of the window it docks below the composer, again at its full width", async () => {
    const { page, release } = await load(undefined, "top");
    try {
      const { before, list } = await docked(page);
      expect(list.side).toBe("below");
      expect(list.width).toBe(before.width);
      expect(list.top - before.bottom).toBe(6);
    } finally {
      release();
      await page.close();
    }
  });
});

describe("keyboard flow: /zuw ⏎ val ⏎", () => {
  const flow = async (page: Page) => {
    const text = page.getByRole("textbox", { name: "Nachricht" });
    await text.click();
    await page.keyboard.type("Guten Tag, ");
    await page.keyboard.type("/zuw");
    await page.keyboard.press("Enter");
    // The second level has its own search field, which has the focus; the `/zuw` left the text.
    await page.locator(".k2b-dropdown__search > input:focus").waitFor();
    expect(await text.inputValue()).toBe("Guten Tag, ");
    await page.keyboard.type("val");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (globalThis as unknown as { assigned: unknown[] }).assigned.length > 0);
    return {
      assigned: await page.evaluate(() => (globalThis as unknown as { assigned: unknown[] }).assigned),
      text: await text.inputValue(),
      focus: await page.evaluate(() => {
        const element = document.activeElement as HTMLTextAreaElement | null;
        return { tag: element?.tagName, caret: element?.selectionStart };
      }),
      open: await page.locator(".k2b-autocomplete__options[data-commands]").count(),
    };
  };

  test("Enter opens the person search, the typed name finds them, Enter assigns, and the focus is back in the text", async () => {
    const { page, release } = await load();
    try {
      const result = await flow(page);
      expect(result.assigned).toEqual([{ name: "Valentin Brandt", path: ["Zuweisen"], text: "Guten Tag, " }]);
      expect(result.text).toBe("Guten Tag, ");
      expect(result.focus).toEqual({ tag: "TEXTAREA", caret: "Guten Tag, ".length });
      expect(result.open).toBe(0);
    } finally {
      release();
      await page.close();
    }
  });

  test("Enter while the search still loads waits for that search and assigns its first match", async () => {
    const { page, release } = await load(undefined, "bottom", "#slow");
    try {
      const result = await flow(page);
      expect(result.assigned).toEqual([{ name: "Valentin Brandt", path: ["Zuweisen"], text: "Guten Tag, " }]);
      expect(result.focus).toEqual({ tag: "TEXTAREA", caret: "Guten Tag, ".length });
    } finally {
      release();
      await page.close();
    }
  });
});

describe("command outcomes", () => {
  const boxes = (page: Page) =>
    page.evaluate(() => {
      const composer = document.getElementById("composer")!.getBoundingClientRect();
      const line = document.querySelector<HTMLElement>(".k2b-autocomplete__options[data-commands]")!;
      const rect = line.getBoundingClientRect();
      return {
        composer: { left: composer.left, top: composer.top, width: composer.width },
        line: {
          left: rect.left,
          width: rect.width,
          bottom: rect.bottom,
          outcome: line.dataset.outcome,
          background: getComputedStyle(line).backgroundColor,
        },
        focus: document.activeElement?.tagName,
      };
    });

  test("a confirmation stays docked in green, the composer stays put, and typing clears it only after 1.2 s", async () => {
    const { page, release } = await load(undefined, "bottom", "#report");
    try {
      const text = page.getByRole("textbox", { name: "Nachricht" });
      await text.click();
      await settled(page);
      const before = await page.evaluate(() => document.getElementById("composer")!.getBoundingClientRect().top);
      await page.keyboard.type("Guten Tag, /zuw");
      await page.keyboard.press("Enter");
      await page.locator(".k2b-dropdown__search > input:focus").waitFor();
      await page.keyboard.type("val");
      await page.keyboard.press("Enter");
      const line = page.locator(".k2b-command-outcome[data-state='success']");
      await line.waitFor();
      // The container keeps its place and fades to green; it is measured once that settled.
      await settled(page);
      const state = await boxes(page);
      expect(await line.textContent()).toContain("Valentin Brandt zugewiesen");
      expect(state.line.outcome).toBe("success");
      expect(state.line.background).toBe("rgb(236, 253, 245)");
      expect(state.line.left).toBe(state.composer.left);
      expect(state.line.width).toBe(state.composer.width);
      // Docked as the list was: its bottom edge 6 px above the composer, which has not moved.
      expect(state.line.bottom).toBe(state.composer.top - 6);
      expect(state.composer.top).toBe(before);
      expect(state.focus).toBe("TEXTAREA");
      await page.keyboard.type("D");
      expect(await line.isVisible()).toBe(true);
      // The exact least time is covered with a frozen clock in command-context.behavior.test.tsx.
      await line.waitFor({ state: "detached" });
      expect(await text.inputValue()).toBe("Guten Tag, D");
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
    } finally {
      release();
      await page.close();
    }
  });

  test("Retry in the + menu keeps the menu open and runs in the error's place until it finishes", async () => {
    const { page, release } = await load(undefined, "bottom", "#report");
    try {
      const menu = page.locator(".k2b-command-menu");
      await page.getByRole("option", { name: /Kunstbörse/ }).click();
      await menu.locator(".k2b-command-outcome[data-state='error']").waitFor();
      expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-command-outcome"))).toBe(true);
      await page.getByRole("button", { name: "Retry" }).click();
      await menu.locator(".k2b-command-outcome[data-state='running']").waitFor();
      expect(await menu.evaluate((element) => element.matches(":popover-open"))).toBe(true);
      await page.evaluate(() => (globalThis as unknown as { releaseRetry: () => void }).releaseRetry());
      await page.waitForFunction(() => !document.querySelector(".k2b-command-menu:popover-open"));
    } finally {
      release();
      await page.close();
    }
  });

  test("a failed command turns red with Retry and stays; Escape clears it; reduced motion has no animation", async () => {
    const { page, release } = await load(undefined, "bottom", "#report");
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.getByRole("textbox", { name: "Nachricht" }).click();
      await page.keyboard.type("/kunst");
      await page.keyboard.press("Enter");
      const line = page.locator(".k2b-command-outcome[data-state='error']");
      await line.waitFor();
      await settled(page);
      expect(await page.getByRole("alert").textContent()).toBe("Kunstbörse ist nicht erreichbar");
      expect(await page.getByRole("button", { name: "Retry" }).isVisible()).toBe(true);
      expect((await boxes(page)).line.background).toBe("rgb(254, 242, 242)");
      expect(await line.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
      await page.keyboard.press("Escape");
      await line.waitFor({ state: "detached" });
      expect(await page.locator(".k2b-autocomplete__options[data-commands]").count()).toBe(0);
    } finally {
      release();
      await page.close();
    }
  });
});

describe("command images", () => {
  test("an image keeps its 16 px box before it loads, and every label starts on the same line", async () => {
    const { page, release } = await load();
    try {
      await settled(page);
      // settled: the slow logo has not arrived yet; its box is the subject.
      const before = await geometry(page, "Trödelplatz");
      expect(before.image).toEqual({ width: 16, height: 16, src: "/logo/slow.svg", alt: "" });
      const rows = await Promise.all(["Telefonat", "Trödelplatz", "Antikmarkt", "Mara Brandt"].map((label) => geometry(page, label)));
      for (const row of rows) {
        expect(row.slot.width).toBe(20);
        expect(Math.abs(row.label - rows[0]!.label)).toBeLessThan(0.5);
      }
      release();
      await page.waitForFunction(() =>
        [...document.querySelectorAll<HTMLImageElement>(".k2b-command-list__image > img")].every((img) => img.complete),
      );
      await settled(page);
      const after = await geometry(page, "Trödelplatz");
      expect(after).toEqual(before);
    } finally {
      await page.close();
    }
  });

  test("a pair of images shows the light one in the light theme and the dark one in the dark theme", async () => {
    const light = await load();
    const dark = await load("dark");
    try {
      await settled(light.page);
      await settled(dark.page);
      expect((await geometry(light.page, "Antikmarkt")).image?.src).toBe("/logo/light.svg");
      expect((await geometry(dark.page, "Antikmarkt")).image?.src).toBe("/logo/dark.svg");
      expect((await geometry(dark.page, "Antikmarkt")).image).toMatchObject({ width: 16, height: 16 });
    } finally {
      light.release();
      dark.release();
      await light.page.close();
      await dark.page.close();
    }
  });
});
