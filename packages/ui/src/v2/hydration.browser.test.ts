import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-hydration.client";
import type {} from "../../test/v2-hydration-twice";
import { measureV2Layout } from "./testing";
import { hairline, heights, textEdge } from "./tokens";

// The primitives rendered on the server and hydrated in the browser, as a page with islands that hydrate would: the
// development build of Solid throws on a node the server did not send, so a mismatch fails here. The fixture
// (test/v2-hydration.fixture.tsx) holds the cases of the review of #4058.

const here = import.meta.dir;
const css = readFileSync(resolve(here, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";
const bundle = bundleV2Entry;

type Server = { html: string; script: string; made: { cells: number; probe: number } };

let browser: Browser;
let client: string;
let server: Server;
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-hydration-"));
beforeAll(async () => {
  const serverCode = await bundle("v2-hydration.server.tsx", "ssr");
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, serverCode);
  const { render }: { render: () => Server } = await import(serverFile);
  server = render();
  [client, browser] = await Promise.all([bundle("v2-hydration.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

const withPage = async (run: (page: Page) => Promise<void>, width = 1440) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8">${server.script}<style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${server.html}</div></body></html>`,
    );
    // what the server sent, kept to compare with the page once it is live
    await page.evaluate(() => {
      window.__k2Sent = document.getElementById("root")!.cloneNode(true);
    });
    await page.addScriptTag({ content: client });
    await page
      .waitForFunction(() => window.__k2Hydrated === true)
      .catch(() => {
        throw new Error(`the page did not hydrate: ${[...errors, ...consoleErrors].join(" | ")}`);
      });
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await page.close();
  }
};

/**
 * Runs in the page: where the live page differs from what the server sent, in elements, texts and attributes. The
 * keys of hydration and comments do not count; a style counts by its declarations, not their spelling. A place the
 * live page measures (a grip in the middle of the part of its line in sight) is set after hydration and does not count.
 */
const differencesInPage = () => {
  const sent = window.__k2Sent!;
  const live = document.getElementById("root")!;
  const found: string[] = [];
  const style = (element: Element) => {
    const probe = document.createElement("i");
    probe.setAttribute("style", element.getAttribute("style") ?? "");
    return Array.from(probe.style)
      .filter((name) => name !== "--k2-grip-top")
      .map((name) => `${name}:${probe.style.getPropertyValue(name)}`)
      .sort()
      .join(";");
  };
  const nodes = (parent: Node) =>
    Array.from(parent.childNodes).filter((node) => node.nodeType === 1 || (node.nodeType === 3 && node.textContent !== ""));
  const walk = (a: Node, b: Node, path: string) => {
    if (a.nodeType === 3 || b.nodeType === 3) {
      if (a.nodeType !== b.nodeType || a.textContent !== b.textContent)
        found.push(`${path}: text "${a.textContent}" became "${b.textContent}"`);
      return;
    }
    if (!(a instanceof Element) || !(b instanceof Element)) return;
    if (a.tagName !== b.tagName) {
      found.push(`${path}: <${a.tagName}> became <${b.tagName}>`);
      return;
    }
    const names = new Set([...a.getAttributeNames(), ...b.getAttributeNames()].filter((name) => name !== "data-hk"));
    for (const name of names) {
      const same = name === "style" ? style(a) === style(b) : a.getAttribute(name) === b.getAttribute(name);
      if (!same) found.push(`${path} ${a.tagName.toLowerCase()}[${name}]: "${a.getAttribute(name)}" became "${b.getAttribute(name)}"`);
    }
    const [left, right] = [nodes(a), nodes(b)];
    if (left.length !== right.length) found.push(`${path} ${a.tagName.toLowerCase()}: ${left.length} children became ${right.length}`);
    left.forEach((child, index) => {
      const other = right[index];
      if (other) walk(child, other, `${path} > ${index}`);
    });
  };
  walk(sent, live, "root");
  return found;
};

test("hydration: the live page is what the server sent, in elements, texts and attributes", async () => {
  await withPage(async (page) => {
    expect(await page.evaluate(differencesInPage)).toEqual([]);
  });
});

test("red: a component that reads a prop holding JSX twice fails to hydrate, so the test above would see it", async () => {
  const serverFile = resolve(temp, "twice.js");
  await Bun.write(serverFile, await bundle("v2-hydration-twice.tsx", "ssr"));
  const { render }: { render: () => { html: string; script: string } } = await import(serverFile);
  const sent = render();
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(`<!doctype html><html><head>${sent.script}</head><body><div id="twice">${sent.html}</div></body></html>`);
    await page.addScriptTag({ content: await bundle("v2-hydration-twice.tsx", "dom") }).catch(() => undefined);
    await page.waitForFunction(() => window.__k2TwiceDone === true);
    expect(errors.some((error) => error.includes("Hydration Mismatch"))).toBe(true);
    errors.length = 0;
  } finally {
    await page.close();
  }
});

test("the comparison of sent and live pages finds a changed attribute and a changed text", async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      document.querySelector(".k2-field-label")!.setAttribute("data-probe", "changed");
      const title = document.querySelector(".k2-row-title")!.firstChild!;
      title.textContent = `${title.textContent} (neu)`;
    });
    const found = await page.evaluate(differencesInPage);
    expect(found.some((line) => line.includes("[data-probe]"))).toBe(true);
    expect(found.some((line) => line.includes("(neu)"))).toBe(true);
  });
});

test("a box set for some of a group is the browser's third state", async () => {
  await withPage(async (page) => {
    expect(
      await page
        .getByRole("checkbox", { name: "Einige Positionen" })
        .evaluate((input) => input instanceof HTMLInputElement && input.indeterminate),
    ).toBe(true);
    expect(await page.getByRole("checkbox", { name: "Einige Positionen" }).getAttribute("aria-checked")).toBeNull();
  });
});

test("hydration: the browser finds every node the server sent, and every name points at an element", async () => {
  await withPage(async (page) => {
    const names = await page.evaluate(() => {
      const missing: string[] = [];
      for (const label of document.querySelectorAll("label[for]")) {
        const target = document.getElementById(label.getAttribute("for") ?? "");
        if (!target || !["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) missing.push(`label for=${label.getAttribute("for")}`);
      }
      for (const attribute of ["aria-labelledby", "aria-describedby"])
        for (const element of document.querySelectorAll(`[${attribute}]`))
          for (const id of element.getAttribute(attribute)!.split(/\s+/))
            if (!document.getElementById(id)) missing.push(`${attribute}=${id}`);
      return missing;
    });
    expect(names).toEqual([]);
  });
});

test("every cell and every field is made once, on the server and in the browser; a group head stands in both places", async () => {
  // 2 rows × 3 columns
  expect(server.made).toEqual({ cells: 6, probe: 1 });
  await withPage(async (page) => {
    expect(await page.evaluate(() => globalThis.__k2Made)).toEqual({ cells: 6, probe: 1 });
    // the head of each group is in the table and in the phone list, each its own
    expect(await page.locator(".k2-table tr[data-group] .k2-chip").allTextContents()).toEqual(["Offen", "Erledigt"]);
    expect(await page.locator(".k2-table-phone .k2-bar .k2-chip").allTextContents()).toEqual(["Offen", "Erledigt"]);
  });
});

test("an entry that opens something holds no control inside a control, and each control keeps its target", async () => {
  await withPage(async (page) => {
    expect(await page.locator(":is(a, button) :is(a, button)").count()).toBe(0);
    expect(await page.locator('[role="listitem"]:not(div)').count()).toBe(0);
    const hash = () => page.evaluate(() => location.hash);
    const row = page.locator('.k2-row:has-text("Holzwerk Brandt")');
    // the empty middle of the row opens it
    const box = (await row.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    expect(await hash()).toBe("#holzwerk");
    await row.getByRole("link", { name: "AN-4471" }).click();
    expect(await hash()).toBe("#angebot");
    await row.getByRole("button", { name: "Mehr zu Holzwerk" }).click();
    expect(await hash()).toBe("#angebot");
    await page.getByText("Geöffnet: mehr").waitFor();
    await page.getByRole("button", { name: "Jonas Hartwig" }).click();
    await page.getByText("Geöffnet: jonas").waitFor();
    await page.getByRole("button", { name: "Annehmen" }).click();
    await page.getByText("Geöffnet: annehmen").waitFor();
    // a digest entry and a table row open from anywhere on them, their own links stay theirs
    // a link in the title of a row stays its own; the row is opened by the element named by that title
    const entries = page.getByRole("list", { name: "Einträge" });
    await entries.getByRole("link", { name: "EL-2611", exact: true }).click();
    expect(await hash()).toBe("#einlieferung");
    expect(await entries.getByRole("link", { name: "Einlieferung EL-2611" }).getAttribute("href")).toBe("#zeile");
    await page.locator('[data-k2-part="Digest.Entry"]').getByRole("link", { name: "Q-21" }).click();
    expect(await hash()).toBe("#quittung");
    await page.locator(".k2-table td", { hasText: "617,00 €" }).click();
    expect(await hash()).toBe("#AU-2");
  });
});

test("a pane that comes and goes takes its seam with it", async () => {
  await withPage(async (page) => {
    // the seams between panes: the one after the last pane is hidden and has no grip
    const seams = () => page.locator(".k2-split > .k2-seam:visible").count();
    const grips = () => page.locator(".k2-split > .k2-seam > .k2-grip").count();
    expect([await seams(), await grips()]).toEqual([2, 2]);
    await page.getByRole("button", { name: "Info", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Info"].k2-pane'));
    expect([await seams(), await grips()]).toEqual([1, 1]);
    await page.getByRole("button", { name: "Info", exact: true }).click();
    await page.locator('.k2-pane[aria-label="Info"]').waitFor();
    expect([await seams(), await grips()]).toEqual([2, 2]);
  });
});

test("fields: one control is labelled, a field of choices is a named group, a message is read only when there is one", async () => {
  await withPage(async (page) => {
    expect(await page.getByRole("group", { name: "Übergabe" }).count()).toBe(1);
    expect(await page.getByRole("radiogroup", { name: "Übergabe" }).count()).toBe(1);
    expect(
      await page.getByRole("group", { name: "Benachrichtigung" }).getByRole("checkbox", { name: "Kunde benachrichtigen" }).count(),
    ).toBe(1);
    expect(await page.getByRole("textbox", { name: "Ansprechperson" }).getAttribute("aria-describedby")).toBeNull();
    expect(await page.getByRole("combobox", { name: "Art" }).getAttribute("aria-describedby")).not.toBeNull();
  });
});

test("controls without a handler keep their own state, and the shape shows it", async () => {
  await withPage(async (page) => {
    const select = page.locator('[data-k2-part="Select"]');
    await select.click();
    await page.locator('.k2-menu[data-listbox] .k2-mi:has-text("Montage")').click();
    await page.locator(".k2-menu[data-listbox]").waitFor({ state: "hidden" });
    expect(await select.locator(".k2-input-value").textContent()).toBe("Montage");
    const check = page.getByRole("checkbox", { name: "Kunde benachrichtigen" });
    await check.check();
    expect(await page.locator('[data-k2-part="Check"] .k2-check').first().getAttribute("data-checked")).toBe("");
    await page.getByText("Abholung").click();
    expect(await page.locator(".k2-radio[data-checked]").count()).toBe(1);
    expect(await page.getByRole("radio", { name: "Abholung" }).isChecked()).toBe(true);
  });
});

test("facts are pairs of term and value, Markdown in prose runs nothing", async () => {
  await withPage(async (page) => {
    const facts = await page.evaluate(() => {
      const list = document.querySelector("dl.k2-facts")!;
      return [...list.children].map((pair) => `${pair.tagName}:${[...pair.children].map((child) => child.tagName).join(",")}`);
    });
    expect(facts).toEqual(["DIV:DT,DD", "DIV:DT,DD"]);
    expect(await page.locator("dl.k2-facts dd .k2-btn").count()).toBe(1);
    const prose = page.locator('[data-k2-part="Prose"]');
    expect(await prose.locator("script, img, [onerror]").count()).toBe(0);
    expect(await prose.locator('a[href^="javascript"]').count()).toBe(0);
    expect(await page.evaluate(() => "__k2Bad" in window)).toBe(false);
    // images load nothing (their words stay); links lead only to web pages and mail addresses
    expect(await prose.getByText("Pixel").count()).toBe(1);
    expect(await prose.locator("a").evaluateAll((links) => links.map((link) => link.getAttribute("href")))).toEqual([
      "https://example.com",
      "mailto:post@example.com",
    ]);
  });
});

for (const width of [1440, 390]) {
  test(`layout at ${width}: no layout rule broken; a row of two lines with marks stays two lines; a button keeps its width`, async () => {
    await withPage(async (page) => {
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      const row = page.locator('.k2-row:has-text("Zwei Zeilen")');
      const rowBox = (await row.boundingBox())!;
      // 52 and its line, as the mockup draws a row of two lines: the marks open no third line. (On the phone the panes
      // stand one under the other and the last row of a pane gives its line to the seam below it.)
      const line = await row.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderBottomWidth));
      expect(line).toBe(width < textEdge.phoneBelow ? 0 : hairline.width);
      expect(rowBox.height).toBe(heights.row2 + line);
      const button = (await page.getByRole("button", { name: "Für sich" }).boundingBox())!;
      const pane = (await page.locator('.k2-pane[aria-label="Mitte"]').boundingBox())!;
      expect(button.width).toBeLessThan(160);
      expect(button.x - pane.x).toBe(width < textEdge.phoneBelow ? textEdge.phone : textEdge.wide);
    }, width);
  });
}

test("dark: the three ways in give the same colours, a light island stays light, an accent mixes its ink and tint", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style><style>.probe { background: var(--k2-app-tint); color: var(--k2-app-text); border-color: var(--k2-surface); outline-color: var(--k2-warn-ink); }</style></head><body>
        <div class="dark"><div class="k2-ui" id="page"><i class="probe"></i></div></div>
        <div class="k2-ui dark" id="scope"><i class="probe"></i></div>
        <div class="k2-ui" data-theme="dark" id="attribute"><i class="probe"></i></div>
        <div class="dark"><div class="k2-ui" data-theme="light" id="island"><i class="probe"></i></div></div>
        <div class="dark"><div class="k2-ui" data-theme="light"><div class="k2-ui" id="nested"><i class="probe"></i></div></div></div>
        <div class="k2-ui" id="light"><i class="probe"></i></div>
        <div style="--k2-app: #0f766e"><div class="k2-ui" id="accent"><i class="probe"></i></div><div class="k2-ui dark" id="accent-dark"><i class="probe"></i></div></div>
        <div style="--k2-app: #ca8a04; --k2-app-ink: #713f12"><div class="k2-ui" id="readable"><i class="probe"></i></div></div>
      </body></html>`,
    );
    await settled(page);
    const colours = await page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll(".probe")].map((probe) => {
          const style = getComputedStyle(probe);
          return [probe.parentElement!.id, [style.backgroundColor, style.color, style.borderTopColor, style.outlineColor].join(" | ")];
        }),
      ),
    );
    expect(colours.scope).toBe(colours.page);
    expect(colours.attribute).toBe(colours.page);
    expect(colours.island).toBe(colours.light);
    // a scope inside a light island stays light, though the page around it is dark
    expect(colours.nested).toBe(colours.light);
    // the platform's readable ink wins over the mix
    expect(colours.readable!.split(" | ")[1]).toBe("rgb(113, 63, 18)");
    expect(colours.page).not.toBe(colours.light);
    // without an app colour the blue of v2 stands; with one, ink and tint follow it in each theme
    expect(colours.light).toContain("rgb(239, 246, 255) | rgb(29, 78, 216)");
    expect(colours.accent).not.toBe(colours.light);
    expect(colours["accent-dark"]).not.toBe(colours.accent);
    expect(colours["accent-dark"]).not.toBe(colours.page);
  } finally {
    await page.close();
  }
});
