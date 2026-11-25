import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import type {} from "../../test/v2-access.client";
import { bundleV2Entry } from "../../test/v2-bundle";
import { measureV2Layout } from "./testing";

// What the agent page of Accounts asked of the primitives (#4110), in the browser: an avatar's picture over its
// initials, heads that sort, a busy button, disabled fields and a disabled deed of a notice, facts with a token and a
// long label, and on the phone a side column under the table without a double line at the seam.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-access.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, width = 1440) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    // the pictures are addresses of their own: they load or fail at once
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".k2-av[data-image]")].every((av) => av.getAttribute("data-image") !== ""),
    );
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const counts = (page: Page) => page.evaluate(() => ({ ...window.__k2Counts! }));

test("an avatar shows its picture over its initials in the same place, and its initials when the picture fails", async () => {
  await withPage(async (page) => {
    const found = await page.evaluate(() => {
      const look = (av: Element) => {
        const box = av.getBoundingClientRect();
        const image = av.querySelector("img")?.getBoundingClientRect();
        return {
          state: av.getAttribute("data-image"),
          box: `${box.width}x${box.height}`,
          image: image ? `${image.left - box.left},${image.top - box.top} ${image.width}x${image.height}` : null,
          initials: getComputedStyle(av).webkitTextFillColor !== "rgba(0, 0, 0, 0)",
          hidden: av.getAttribute("aria-hidden"),
          name: av.getAttribute("aria-label"),
        };
      };
      return {
        head: look(document.querySelector('[data-slot="head"] .k2-av')!),
        failed: look(document.querySelector(".k2-pane[data-side] > .k2-scroll > .k2-bar .k2-av")!),
        row: look(document.querySelector(".k2-pane[data-side] .k2-row .k2-av")!),
      };
    });
    expect(found).toEqual({
      // beside the name in the head the avatar is decoration; the picture covers it exactly, the initials leave
      head: { state: "shown", box: "32x32", image: "0,0 32x32", initials: false, hidden: "true", name: "Wochenbericht" },
      // a picture that fails leaves the initials, in the same size
      failed: { state: "failed", box: "24x24", image: null, initials: true, hidden: null, name: "Jana Berger" },
      row: { state: "shown", box: "32x32", image: "0,0 32x32", initials: false, hidden: null, name: "Jana Berger" },
    });
    // the picture adds no name of its own
    expect(await page.locator(".k2-av img").evaluateAll((images) => images.map((image) => image.getAttribute("alt")))).toEqual(["", ""]);
  });
});

test("a head that sorts is pressed, with the mouse and the keyboard; the cell says the order and shows its arrow", async () => {
  await withPage(async (page) => {
    const heads = () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".k2-table th")].map((th) => ({
          title: th.textContent,
          sort: th.getAttribute("aria-sort"),
          button: th.querySelector("button.k2-th-sort") !== null,
          arrow: th.querySelector(".k2-icon")?.getAttribute("data-name") ?? null,
        })),
      );
    const first = () => page.locator(".k2-table tbody tr:first-child td:first-child .k2-cell-line").first().textContent();
    expect(await heads()).toEqual([
      { title: "Name", sort: "ascending", button: true, arrow: "arrow-up" },
      { title: "Zuletzt genutzt", sort: null, button: true, arrow: null },
      { title: "Status", sort: null, button: false, arrow: null },
    ]);
    expect(await first()).toBe("Laptop Jana");

    await page.getByRole("button", { name: "Name", exact: true }).click();
    await settled(page);
    expect((await heads())[0]).toEqual({ title: "Name", sort: "descending", button: true, arrow: "arrow-down" });
    expect(await first()).toBe("Nachtlauf");

    const used = page.getByRole("button", { name: "Zuletzt genutzt", exact: true });
    await used.focus();
    await page.keyboard.press("Enter");
    await settled(page);
    expect((await heads()).map((head) => head.sort)).toEqual([null, "ascending", null]);
    expect(await first()).toBe("Nachtlauf");
    // the head keeps the focus, with the ring of a link
    expect(await used.evaluate((element) => document.activeElement === element && getComputedStyle(element).outlineStyle)).toBe("solid");
    await page.keyboard.press("Space");
    await settled(page);
    expect((await heads())[1]!.sort).toBe("descending");
    expect((await counts(page)).sort).toBe(3);
  });
});

test("a toggle says whether it is on and turns its symbol to the colour of pressed, without moving", async () => {
  await withPage(async (page) => {
    const star = page.getByRole("button", { name: "Favorit" });
    const look = () =>
      star.evaluate((element) => ({
        pressed: element.getAttribute("aria-pressed"),
        color: getComputedStyle(element.querySelector(".k2-icon")!).color,
        box: (({ left, top, width, height }) => `${left},${top} ${width}x${height}`)(element.getBoundingClientRect()),
      }));
    const off = await look();
    expect(off.pressed).toBe("false");
    await star.click();
    await settled(page);
    // the colour of pressed (light): the orange of the mockup's favourite star
    expect(await look()).toEqual({ pressed: "true", color: "rgb(180, 83, 9)", box: off.box });
    await star.click();
    await settled(page);
    expect(await look()).toEqual(off);
  });
});

test("a busy button keeps its width, its name and the focus, and takes no second press", async () => {
  await withPage(async (page) => {
    const button = page.getByRole("button", { name: "Bild ändern" });
    const look = () =>
      button.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        busy: element.getAttribute("aria-busy"),
        disabled: element.getAttribute("aria-disabled"),
        sign: element.querySelector(".k2-btn-busy") !== null,
        label: getComputedStyle(element.querySelector(".k2-btn-label")!).opacity,
        // dimmed is for what is off; a busy button keeps its look
        opacity: getComputedStyle(element).opacity,
        focused: document.activeElement === element,
      }));
    const before = await look();
    expect(before).toMatchObject({ busy: null, disabled: null, sign: false, label: "1", opacity: "1" });
    await button.click();
    await settled(page);
    expect(await look()).toEqual({ ...before, busy: "true", disabled: "true", sign: true, label: "0", focused: true });
    // a busy button says it is off, so the press is forced, as a hurried second click would come
    await button.click({ force: true });
    await page.keyboard.press("Enter");
    await settled(page);
    expect((await counts(page)).picture).toBe(1);
    await page.evaluate(() => window.__k2Done?.());
    await settled(page);
    expect(await look()).toEqual({ ...before, focused: true });
  });
});

test("Enter in a field does not send a form whose submit button is busy; it sends one whose button is not", async () => {
  await withPage(async (page) => {
    await page.getByRole("textbox", { name: "Name beim Speichern" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "Name", exact: true }).focus();
    await page.keyboard.press("Enter");
    await settled(page);
    const { sentBusy, sentIdle } = await counts(page);
    expect({ sentBusy, sentIdle }).toEqual({ sentBusy: 0, sentIdle: 1 });
  });
});

test("disabled fields, options and the deed of a notice look off and take no input", async () => {
  await withPage(async (page) => {
    const found = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>(".k2-input[data-disabled] > input")!;
      const radios = [...document.querySelectorAll<HTMLInputElement>('[data-k2-part="Choice"] input')];
      const check = document.querySelector<HTMLInputElement>('[data-k2-part="Check"] input')!;
      return {
        input: [input.disabled, getComputedStyle(input.parentElement!).backgroundColor],
        group: document.querySelector('[data-k2-part="Choice"]')!.getAttribute("aria-disabled"),
        radios: radios.map((radio) => radio.disabled),
        options: [...document.querySelectorAll('[data-k2-part="Choice"] > .k2-choice')].map((option) => getComputedStyle(option).opacity),
        check: [check.disabled, getComputedStyle(check.closest(".k2-choice")!).opacity],
        notice: document.querySelector<HTMLButtonElement>(".k2-notice .k2-btn")!.disabled,
        // the way at the end of a section: an anchor without an address
        more: (() => {
          const link = document.querySelector(".k2-sec-link")!;
          return [link.localName, link.getAttribute("href"), link.getAttribute("aria-disabled"), getComputedStyle(link).opacity];
        })(),
      };
    });
    expect(found).toEqual({
      input: [true, "rgb(244, 244, 245)"],
      group: "true",
      radios: [true, true],
      options: ["0.5", "0.5"],
      check: [true, "0.5"],
      notice: true,
      more: ["a", null, "true", "0.5"],
    });
    await page.locator(".k2-notice .k2-btn").click({ force: true });
    await page.locator('[data-k2-part="Choice"] .k2-choice').last().click({ force: true });
    await settled(page);
    expect((await counts(page)).resume).toBe(0);
    expect(
      await page
        .locator('[data-k2-part="Choice"] input')
        .evaluateAll((radios) => radios.map((radio) => (radio as HTMLInputElement).checked)),
    ).toEqual([true, false]);
  });
});

test("facts: the label column takes the longest label, a token is monospace and breaks at any sign", async () => {
  await withPage(async (page) => {
    const found = await page.evaluate(() => {
      const [used, token] = [...document.querySelectorAll(".k2-fact-pair")];
      const label = used!.querySelector("dt")!;
      const value = token!.querySelector(".k2-fact-value")!;
      const style = getComputedStyle(value);
      return {
        // one line of 20 px between the paddings of 6 px
        label: label.getBoundingClientRect().height,
        mono: style.fontFamily.includes("monospace"),
        wordBreak: style.wordBreak,
        select: style.userSelect || style.webkitUserSelect,
        // the token stays inside its column
        inside: value.getBoundingClientRect().right <= token!.querySelector("dd")!.getBoundingClientRect().right + 0.5,
      };
    });
    expect(found).toEqual({ label: 32, mono: true, wordBreak: "break-all", select: "all", inside: true });
  });
});

test("the layout rules hold at 1440 and 390 px, also where the side column stands under the table", async () => {
  for (const width of [1440, 390])
    await withPage(async (page) => {
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect(layout.problems).toEqual([]);
      if (width === 390) {
        // the seam is the one line between the table's last row and the side column
        const seam = await page.evaluate(() => {
          const last = [...document.querySelectorAll(".k2-table-phone .k2-row")].at(-1)!;
          return getComputedStyle(last).borderBottomWidth;
        });
        expect(seam).toBe("0px");
      }
    }, width);
});
