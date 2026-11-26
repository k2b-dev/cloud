import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-form-controls.demo";
import { measureV2Layout } from "./testing";

// The form controls of v2 beyond text in a real engine, with v2.css: a field's reset deed in its label line, a locked
// select, tags, an image, a code, a disclosure and a folded group, each through the behaviour layer on the ui-sdk core.
// Runs in Chromium and in WebKit (TEST_BROWSER=webkit).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-form-controls"), serverMarkup("../v2-form-controls"), launchBrowser()]);
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
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};
const deeds = (page: Page) => page.evaluate(() => window.__deeds ?? []);
const field = (page: Page, label: string) => page.locator(".k2-field", { has: page.locator(".k2-field-label", { hasText: label }) });

test("server markup: the code is one named input under drawn boxes, the folded group's content is not sent", () => {
  expect(markup).toContain('autocomplete="one-time-code"');
  expect(markup).toContain('maxlength="6"');
  expect(markup.match(/class="k2-code-box ?"/g)?.length).toBe(6);
  expect(markup).toContain('data-k2-part="TagsInput"');
  expect(markup).toContain(">werkstatt.example<");
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain("Drei Pakete");
  // a closed answer is not sent: the server and the first render show the same closed disclosure
  expect(markup).not.toContain("Sie gelten bis zu ihrem Ende weiter.");
});

test("field action: in the 20 px label line, the field keeps its height, a press runs it", async () => {
  await withPage(async (page) => {
    const session = field(page, "Sitzungsdauer");
    const plain = field(page, "Tarif");
    const [withAction, without] = [await session.boundingBox(), await plain.boundingBox()];
    expect(withAction?.height).toBe(without?.height);
    const action = page.getByRole("button", { name: "Auf Standard zurücksetzen" });
    const [label, button] = [await session.locator(".k2-field-label").boundingBox(), await action.boundingBox()];
    expect(button?.height).toBe(20);
    expect(Math.round((button?.y ?? 0) - (label?.y ?? 0))).toBe(0);
    await action.focus();
    await page.keyboard.press("Enter");
    expect(await deeds(page)).toEqual(["reset"]);
    expect(await session.locator(".k2-input-value").textContent()).toBe("24 Stunden");
  });
});

test("select: a long sender address keeps its start and its domain readable, the whole address as a hint, also in the list", async () => {
  const full = "Annabelle Wohlgemuth-Lindqvist <annabelle.wohlgemuth-lindqvist@tischlerei-wohlgemuth-lindqvist.example>";
  await withPage(async (page) => {
    // what a box shows of a value: its words, whether its start and its domain stand whole in it, and its hint
    const shown = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((box) => {
          const inner = box.getBoundingClientRect();
          const clipped = (element: Element | null) => !element || element.scrollWidth > element.clientWidth + 1;
          const domain = box.querySelector("[data-end]");
          const end = domain?.getBoundingClientRect();
          return {
            text: box.querySelector(".k2-hidden-text")?.textContent ?? box.textContent,
            title: box.querySelector("[title]")?.getAttribute("title") ?? box.getAttribute("title"),
            start: (box.querySelector("[data-start]")?.textContent ?? "").slice(0, 9),
            domain: domain?.textContent ?? "",
            domainWhole: !clipped(domain) && !!end && end.right <= inner.right + 1,
          };
        });
    const trigger = field(page, "Absender").locator(".k2-input-value");
    expect(await shown(".k2-field:has(.k2-field-label:text-is('Absender')) .k2-input-value")).toEqual({
      text: full,
      title: full,
      start: "Annabelle",
      domain: "@tischlerei-wohlgemuth-lindqvist.example>",
      domainWhole: true,
    });
    await trigger.click();
    await page.locator('[role="option"]').first().waitFor();
    // assistive technology hears each address whole, as written
    expect(await page.getByRole("listbox", { name: "Absender" }).ariaSnapshot()).toContain(`- option "${full}" [selected]`);
    expect(await shown('[role="option"]')).toMatchObject({ title: full, start: "Annabelle", domainWhole: true });
  }, 390);
});

for (const width of [1440, 390])
  test(`choice with faces at ${width} px: each option leads with its person, named by its words alone; one or several, by keys, sent with the form`, async () => {
    await withPage(async (page) => {
      const owner = field(page, "Zuständig");
      const team = field(page, "Beteiligt");
      // the names stay the words of the options; the face says nothing a second time
      expect(await owner.ariaSnapshot()).toContain('- radio "Jonas Wolf"');
      expect(await team.ariaSnapshot()).toContain('- checkbox "Jonas Wolf" [checked]');
      expect(await team.getByRole("group").count()).toBeGreaterThan(0);
      // the face stands before the words, 20 px on the line of the words, and the mark stays first
      const line = await owner
        .locator(".k2-choice")
        .first()
        .evaluate((choice) => {
          const mark = choice.querySelector(".k2-mark")!.getBoundingClientRect();
          const face = choice.querySelector(".k2-av")!.getBoundingClientRect();
          const text = choice.querySelector(".k2-choice-text")!.getBoundingClientRect();
          return {
            size: [Math.round(face.width), Math.round(face.height)],
            order: mark.right <= face.left && face.right <= text.left,
            middle: Math.abs(face.top + face.height / 2 - (text.top + 10)) <= 1,
          };
        });
      expect(line).toEqual({ size: [20, 20], order: true, middle: true });
      // keys: an arrow moves the one choice, Space adds another person
      await owner.getByRole("radio", { name: "Anna Berg" }).focus();
      await page.keyboard.press("ArrowDown");
      expect(await owner.getByRole("radio", { name: "Jonas Wolf" }).isChecked()).toBe(true);
      await team.getByRole("checkbox", { name: "Mia Lindqvist-Oswald" }).focus();
      await page.keyboard.press("Space");
      expect(entriesOf((await sent(page)).entries, "owner")).toEqual(["jonas"]);
      expect(entriesOf((await sent(page)).entries, "team")).toEqual(["jonas", "mia"]);
      // the form's reset puts both back
      await reset(page);
      await page.waitForFunction(() => document.querySelectorAll('#sent input[name="team"]:checked').length === 1);
      expect(entriesOf((await sent(page)).entries, "owner")).toEqual(["anna"]);
      expect(entriesOf((await sent(page)).entries, "team")).toEqual(["jonas"]);
    }, width);
  });

for (const width of [1440, 390])
  test(`slider at ${width} px: a unit reads after the number and is heard with it; on the phone the thumb takes a finger (44 px)`, async () => {
    await withPage(async (page) => {
      const corners = field(page, "Ecken");
      const thumb = corners.getByRole("slider", { name: "Ecken" });
      expect(await corners.locator(".k2-slider-value").textContent()).toBe("12 px");
      expect(await thumb.getAttribute("aria-valuetext")).toBe("12 px");
      await thumb.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => document.querySelectorAll(".k2-slider-value")[0]?.textContent === "13 px");
      expect(await thumb.getAttribute("aria-valuetext")).toBe("13 px");
      // the press area is the control (a press anywhere on it sets the thumb there): 36 px high, 44 px on the phone,
      // where a finger takes it; points around the thumb reach the control
      const out = width < 768 ? 21 : 17;
      const area = await corners.locator(".k2-slider-control").evaluate((control, reach) => {
        const thumb = control.querySelector(".k2-slider-thumb")!.getBoundingClientRect();
        const x = thumb.left + thumb.width / 2;
        const y = thumb.top + thumb.height / 2;
        return {
          height: Math.round(control.getBoundingClientRect().height),
          reached: [
            [x, y - reach],
            [x, y + reach],
          ].every(([px, py]) => control.contains(document.elementFromPoint(px!, py!))),
        };
      }, out);
      expect(area).toEqual({ height: width < 768 ? 44 : 36, reached: true });
      // a press near the start of the control, away from the thumb, sets the thumb there
      const control = await corners.locator(".k2-slider-control").boundingBox();
      await page.mouse.click((control?.x ?? 0) + 2, (control?.y ?? 0) + (control?.height ?? 0) / 2);
      await page.waitForFunction(() => {
        const range = [...document.querySelectorAll<HTMLInputElement>('input[type="range"]')].find((input) =>
          input.getAttribute("aria-valuetext")?.endsWith("px"),
        );
        return Number(range?.getAttribute("aria-valuenow")) <= 1;
      });
    }, width);
  });

test("choice held by the page: after a form's reset the boxes and the entries sent are what the page holds", async () => {
  await withPage(async (page) => {
    const notify = field(page, "Benachrichtigen");
    await notify.getByRole("checkbox", { name: "Auf dem Telefon" }).click();
    expect(entriesOf((await sent(page)).entries, "notify")).toEqual(["mail", "push"]);
    await reset(page);
    // one task later the boxes show the page's choice again
    await page.waitForFunction(() => document.querySelectorAll('#sent input[name="notify"]:checked').length === 2);
    expect(entriesOf((await sent(page)).entries, "notify")).toEqual(["mail", "push"]);
  });
});

for (const width of [1440, 390])
  test(`choice as cards at ${width} px: one connected row (a column on the phone), named by their words, keys and form as a radio group`, async () => {
    await withPage(async (page) => {
      const kinds = page.getByRole("radiogroup", { name: "Art der Quelle" });
      // each card is a radio named by its words; its line describes it, its symbol says nothing
      const poll = kinds.getByRole("radio", { name: "Abruf", exact: true });
      expect(await poll.isChecked()).toBe(true);
      const described = await poll.getAttribute("aria-describedby");
      expect(await page.evaluate((id) => document.getElementById(id ?? "")?.textContent, described)).toBe(
        "Cloud fragt in einem Takt nach.",
      );
      expect(await kinds.locator(".k2-icon:not([aria-hidden='true'])").count()).toBe(0);
      // the cards touch: one frame around them and a hairline between them; four stand two by two, a column on the phone
      const boxes = await kinds.locator(".k2-choice").evaluateAll((cards) =>
        cards.map((card) => {
          const box = card.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
        }),
      );
      expect(boxes).toHaveLength(4);
      const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
      const [first, second, third, fourth] = boxes as [(typeof boxes)[0], (typeof boxes)[0], (typeof boxes)[0], (typeof boxes)[0]];
      if (width >= 768) {
        expect([near(second.left, first.right), near(second.top, first.top), near(second.width, first.width)]).toEqual([true, true, true]);
        expect([near(third.top, first.bottom), near(third.left, first.left), near(fourth.left, second.left)]).toEqual([true, true, true]);
      } else {
        for (const [before, after] of [
          [first, second],
          [second, third],
          [third, fourth],
        ] as const)
          expect([near(after.top, before.bottom), near(after.left, before.left)]).toEqual([true, true]);
      }
      const frame = await kinds.evaluate((group) => {
        const style = getComputedStyle(group);
        return { border: style.borderTopWidth, radius: style.borderTopLeftRadius };
      });
      expect(frame).toEqual({ border: "1px", radius: "8px" });
      // the chosen card is framed blue and carries a tick, so it does not rest on colour alone
      const chosen = kinds.locator(".k2-choice").nth(1);
      expect(await chosen.evaluate((card) => getComputedStyle(card).boxShadow)).toContain("inset");
      expect(await chosen.locator(".k2-icon[data-name='check']").count()).toBe(1);
      // the arrows move the choice, as in every radio group, and the form sends it; the group is reached from the
      // keyboard, as a person reaches it (WebKit shows no keyboard ring after a focus set by script)
      await poll.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("ArrowRight");
      await settled(page);
      expect(await kinds.getByRole("radio", { name: "Datei", exact: true }).isChecked()).toBe(true);
      expect(entriesOf((await sent(page)).entries, "source")).toEqual(["file"]);
      // the focused card shows where the keyboard stands
      expect(
        await kinds
          .locator(".k2-choice")
          .nth(2)
          .evaluate((card) => getComputedStyle(card).boxShadow),
      ).toContain("2px");
      // an option that cannot be chosen now is dimmed and never chosen: the arrows pass it (where they go on from the
      // end is the browser's: Chromium wraps to the first, WebKit stays), and a press does nothing
      const mail = kinds.getByRole("radio", { name: "E-Mail", exact: true });
      expect(await mail.isDisabled()).toBe(true);
      await page.keyboard.press("ArrowRight");
      await settled(page);
      expect(await mail.isChecked()).toBe(false);
      await kinds.getByText("E-Mail", { exact: true }).click({ force: true });
      await settled(page);
      expect(await mail.isChecked()).toBe(false);
      expect(await kinds.locator(".k2-choice").nth(3).getAttribute("data-disabled")).toBe("");
    }, width);
  });

test("choice of one: the arrows move the point, and its ring stays while the keyboard moves it (WebKit drops :focus-visible)", async () => {
  await withPage(async (page) => {
    const repeat = page.getByRole("radiogroup", { name: "Wiederholen" });
    await repeat.getByRole("radio", { name: "Nie" }).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowRight");
    await settled(page);
    expect(await repeat.getByRole("radio", { name: "Täglich" }).isChecked()).toBe(true);
    const ring = await repeat
      .locator(".k2-radio")
      .nth(1)
      .evaluate((mark) => getComputedStyle(mark).boxShadow);
    expect(ring).not.toBe("none");
    // a press shows no ring: the pointer needs none
    await repeat.getByText("Wöchentlich").click();
    await settled(page);
    expect(
      await repeat
        .locator(".k2-radio")
        .nth(2)
        .evaluate((mark) => getComputedStyle(mark).boxShadow),
    ).toBe("none");
  });
});

test("choice of several that is required: the form cannot be sent until one is chosen", async () => {
  await withPage(async (page) => {
    const crew = field(page, "Mannschaft");
    const valid = () => page.evaluate(() => document.querySelector<HTMLInputElement>('input[name="crew"]')?.validity.valid);
    expect(await valid()).toBe(false);
    // the reason asks for one of them, and no box is marked as mandatory on its own
    expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('input[name="crew"]')?.validationMessage)).toBe(
      "Wähle mindestens eine Option.",
    );
    expect(await page.evaluate(() => document.querySelectorAll('input[name="crew"][required]').length)).toBe(0);
    await crew.getByRole("checkbox", { name: "Jonas Wolf" }).click();
    expect(await valid()).toBe(true);
    // one box is enough: the second is never asked for
    expect(
      await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('input[name="crew"]')].every((box) => box.validity.valid)),
    ).toBe(true);
    // with none chosen again the field asks again, in the language of the page
    await page.evaluate(() => {
      document.documentElement.lang = "en";
    });
    await crew.getByRole("checkbox", { name: "Jonas Wolf" }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>('input[name="crew"]')?.validationMessage === "Choose at least one option.",
    );
  });
});

test("select in a right-to-left page: an address keeps its own order, name first and domain last", async () => {
  await withPage(async (page) => {
    const order = await page.locator('[dir="rtl"] .k2-ends').evaluate((ends) => {
      const start = ends.querySelector("[data-start]")!.getBoundingClientRect();
      const end = ends.querySelector("[data-end]")!.getBoundingClientRect();
      return start.left < end.left;
    });
    expect(order).toBe(true);
    // a value that is no address carries no hint of its own
    expect(await field(page, "Tarif").locator(".k2-input-value [title]").count()).toBe(0);
  });
});

test("select: a locked select takes no focus and opens nothing; a dimmed option is skipped", async () => {
  await withPage(async (page) => {
    const locked = field(page, "Verfahren").locator("[data-select]");
    expect(await locked.isDisabled()).toBe(true);
    await locked.click({ force: true });
    expect(await page.locator('[data-slot="select-content"]:visible').count()).toBe(0);
    const plan = field(page, "Tarif").locator("[data-select]");
    await plan.focus();
    await page.keyboard.press("ArrowDown");
    await page.getByRole("listbox", { name: "Tarif" }).waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(await deeds(page)).toEqual(["plan:pro"]);
  });
});

test("tags: Enter adds the typed text as a chip, Backspace in the empty field takes it back, a chip's x removes it", async () => {
  await withPage(async (page) => {
    const input = field(page, "Erlaubte Domains").locator("input:not([type=hidden])").first();
    await input.click();
    await page.keyboard.type("k2b.example");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("[data-tags]")?.querySelectorAll(":scope > .k2-chip").length === 2);
    expect(await deeds(page)).toEqual(["tags:werkstatt.example,k2b.example"]);
    expect(await input.inputValue()).toBe("");
    await input.focus();
    await page.keyboard.press("Backspace");
    await page.waitForFunction(() => document.querySelector("[data-tags]")?.querySelectorAll(":scope > .k2-chip").length === 1);
    // each value is sent under the field's name
    expect(
      await page
        .locator('input[type="hidden"][name="domains"]')
        .evaluateAll((inputs) => inputs.map((input) => (input instanceof HTMLInputElement ? input.value : ""))),
    ).toEqual(["werkstatt.example"]);
    await page.getByRole("button", { name: "werkstatt.example entfernen" }).click();
    await page.waitForFunction(() => document.querySelector("[data-tags]")?.querySelectorAll(":scope > .k2-chip").length === 0);
    expect((await deeds(page)).at(-1)).toBe("tags:");
  });
});

test("image: a picked file becomes the value through transform, the preview shows it, remove clears it", async () => {
  await withPage(async (page) => {
    const logo = field(page, "Logo");
    expect(await logo.getAttribute("role")).toBe("group");
    await logo.locator('input[type="file"]').setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from("logo") });
    await logo.locator(".k2-image-preview > img").waitFor();
    expect(await deeds(page)).toEqual(["image:set"]);
    expect(await logo.getByRole("button", { name: "Bild ändern" }).count()).toBe(1);
    await logo.getByRole("button", { name: "Bild entfernen" }).click();
    await logo.locator(".k2-image-preview > img").waitFor({ state: "detached" });
    expect(await deeds(page)).toEqual(["image:set", "image:none"]);
    // a file that `accept` rules out says so at the field
    await logo.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await logo.getByRole("alert").waitFor();
  });
});

test("code: typing fills the boxes, the last box completes it, the input is the one named control", async () => {
  await withPage(async (page) => {
    const code = page.getByRole("textbox", { name: "Code vom anderen Gerät" });
    await code.focus();
    await page.keyboard.type("12a3456");
    await page.waitForFunction(() => (window.__deeds ?? []).some((deed) => deed.startsWith("code:")));
    expect(await deeds(page)).toEqual(["code:123456"]);
    expect(await page.locator(".k2-code-box").allTextContents()).toEqual(["1", "2", "3", "4", "5", "6"]);
  });
});

test("slider: named by its field, arrows step it, the end of a key press commits, the number reads at the end", async () => {
  await withPage(async (page) => {
    const slider = page.getByRole("slider", { name: "Abdunkeln" });
    expect(await slider.inputValue()).toBe("30");
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("End");
    await page.waitForFunction(() => (window.__deeds ?? []).includes("dim:100"));
    expect(await field(page, "Abdunkeln").locator(".k2-slider-value").textContent()).toBe("100");
    const [control, thumb] = [
      await field(page, "Abdunkeln").locator(".k2-slider").boundingBox(),
      await field(page, "Abdunkeln").locator(".k2-slider-thumb").boundingBox(),
    ];
    expect(control?.height).toBe(36);
    expect(thumb?.width).toBe(16);
  });
});

test("colour: a swatch press sets it, a typed CSS colour becomes its code, the hue thumb is named and steps", async () => {
  await withPage(async (page) => {
    const accent = field(page, "Akzentfarbe");
    const code = accent.getByRole("textbox", { name: "Farbcode" });
    expect(await code.inputValue()).toBe("#b45309");
    await accent.getByRole("option", { name: "Farbe #1d4ed8" }).click();
    expect(await code.inputValue()).toBe("#1d4ed8");
    await code.fill("rgb(15, 118, 110)");
    await code.press("Enter");
    await page.waitForFunction(() => (window.__deeds ?? []).includes("accent:#0f766e"));
    expect(await accent.getByRole("option", { name: "Farbe #0f766e" }).getAttribute("aria-selected")).toBe("true");
    // area and hue stand on a panel behind the swatch, so a settings row stays one line
    await accent.getByRole("button", { name: "Farbe wählen" }).click();
    const hue = page.getByRole("slider", { name: "Farbton" });
    const before = await hue.getAttribute("aria-valuenow");
    await hue.focus();
    await page.keyboard.press("ArrowRight");
    expect(await hue.getAttribute("aria-valuenow")).not.toBe(before);
    expect(await accent.getByRole("slider", { name: "Sättigung und Helligkeit" }).count()).toBe(1);
    // the values are said in the page's language
    expect(await hue.getAttribute("aria-valuetext")).toMatch(/^\d+ Grad$/);
    expect(await accent.getByRole("slider", { name: "Sättigung und Helligkeit" }).getAttribute("aria-valuetext")).toMatch(
      /^Sättigung \d+ %, Helligkeit \d+ %$/,
    );
  });
});

test("disclosure and folded group open and close in place and say so", async () => {
  await withPage(async (page) => {
    const question = page.getByRole("button", { name: "Was passiert mit laufenden Sitzungen?" });
    expect(await question.getAttribute("aria-expanded")).toBe("false");
    await question.click();
    expect(await question.getAttribute("aria-expanded")).toBe("true");
    expect(await page.getByText("Sie gelten bis zu ihrem Ende weiter.").isVisible()).toBe(true);
    const fold = page.getByRole("button", { name: "Lieferung 4711" });
    expect(await fold.getAttribute("aria-expanded")).toBe("false");
    await fold.focus();
    await page.keyboard.press("Enter");
    await page.getByText("Drei Pakete").waitFor();
    expect(await page.locator(".k2-group").getAttribute("data-folded")).toBeNull();
    await page.keyboard.press("Enter");
    await page.getByText("Drei Pakete").waitFor({ state: "hidden" });
  });
});

// What a form sends and what its reset puts back, read as the browser sends it.
const sent = (page: Page) =>
  page.evaluate(() => {
    const form = document.getElementById("sent");
    if (!(form instanceof HTMLFormElement)) return { entries: [], valid: false };
    const entries = [...new FormData(form)].map(([name, value]) => ({
      name,
      value: typeof value === "string" ? value : `file:${value.name}`,
    }));
    return { entries, valid: form.checkValidity() };
  });
const reset = (page: Page) =>
  page.evaluate(() => {
    const form = document.getElementById("sent");
    if (form instanceof HTMLFormElement) form.reset();
  });
type Entry = { name: string; value: string };
const entriesOf = (entries: Entry[], name: string) => entries.filter((entry) => entry.name === name).map((entry) => entry.value);
const files = (entries: Entry[]) => entries.filter((entry) => entry.value.startsWith("file:"));

test("a form sends the tags one entry each, nothing of a locked list, the image's value and no file entry", async () => {
  await withPage(async (page) => {
    let form = await sent(page);
    expect(entriesOf(form.entries, "hosts")).toEqual(["mx1.example"]);
    expect(entriesOf(form.entries, "locked")).toEqual([]);
    expect(files(form.entries)).toEqual([]);
    // the image is required and still empty: the form is not valid
    expect(entriesOf(form.entries, "banner")).toEqual([""]);
    expect(form.valid).toBe(false);
    await field(page, "Banner")
      .locator('input[type="file"]')
      .setInputFiles({ name: "b.png", mimeType: "image/png", buffer: Buffer.from("b") });
    await field(page, "Banner").locator(".k2-image-preview > img").waitFor();
    form = await sent(page);
    expect(entriesOf(form.entries, "banner")).toEqual(["data:text/plain,b"]);
    expect(files(form.entries)).toEqual([]);
    expect(form.valid).toBe(true);
    // the picker said nothing in English
    expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/accepted|rejected/i);
  });
});

test("tags: named by their field's label; a form's reset puts the uncontrolled list back", async () => {
  await withPage(async (page) => {
    const input = page.getByRole("combobox", { name: "Server", exact: true });
    expect(await input.count()).toBe(1);
    await input.click();
    await page.keyboard.type("mx2.example");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#sent [data-tags] > .k2-chip").length === 3);
    expect(entriesOf((await sent(page)).entries, "hosts")).toEqual(["mx1.example", "mx2.example"]);
    await reset(page);
    await page.waitForFunction(() => document.querySelectorAll("#sent [data-tags] > .k2-chip").length === 2);
    expect(entriesOf((await sent(page)).entries, "hosts")).toEqual(["mx1.example"]);
  });
});

test("slider: its thumb carries the field's label and hint; a form's reset puts the input, the number shown and the value sent back together", async () => {
  await withPage(async (page) => {
    const thumb = page.getByRole("slider", { name: "Stufe" });
    expect(await thumb.evaluate((el) => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent)).toBe(
      "Wie stark abgedunkelt wird.",
    );
    await thumb.focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.querySelector("#sent .k2-slider-value")?.textContent === "100");
    expect(entriesOf((await sent(page)).entries, "level")).toEqual(["100"]);
    await reset(page);
    await page.waitForFunction(() => document.querySelector("#sent .k2-slider-value")?.textContent === "30");
    expect(await thumb.inputValue()).toBe("30");
    expect(entriesOf((await sent(page)).entries, "level")).toEqual(["30"]);
  });
});

test("image: while a picked image is still being read, the required field keeps the form from being sent", async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.__k2Gate = new Promise((done) => {
        Reflect.set(window, "__k2Open", done);
      });
    });
    await field(page, "Banner")
      .locator('input[type="file"]')
      .setInputFiles({ name: "b.png", mimeType: "image/png", buffer: Buffer.from("b") });
    await page.waitForFunction(() => document.querySelector('#sent [data-k2-part="ImageInput"] [aria-busy="true"]'));
    expect((await sent(page)).valid).toBe(false);
    await page.evaluate(() => Reflect.get(window, "__k2Open")?.());
    await field(page, "Banner").locator(".k2-image-preview > img").waitFor();
    expect((await sent(page)).valid).toBe(true);
  });
});

test("image: a second image picked while the first is still read wins; the first one's value never arrives", async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.__k2Gate = new Promise((done) => {
        Reflect.set(window, "__k2Open", done);
      });
    });
    const picker = field(page, "Banner").locator('input[type="file"]');
    await picker.setInputFiles({ name: "a.png", mimeType: "image/png", buffer: Buffer.from("a") });
    await page.waitForFunction(() => document.querySelector('#sent [data-k2-part="ImageInput"] [aria-busy="true"]'));
    await picker.setInputFiles({ name: "b.png", mimeType: "image/png", buffer: Buffer.from("b") });
    await page.evaluate(() => Reflect.get(window, "__k2Open")?.());
    await field(page, "Banner").locator(".k2-image-preview > img").waitFor();
    await page.waitForFunction(() => !document.querySelector('#sent [data-k2-part="ImageInput"] [aria-busy="true"]'));
    expect(entriesOf((await sent(page)).entries, "banner")).toEqual(["data:text/plain,b"]);
  });
});

test("slider held by the page: after a form reset the input, the number shown and the value sent all show the page's value", async () => {
  await withPage(async (page) => {
    const thumb = page.getByRole("slider", { name: "Zoom" });
    await thumb.focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.querySelectorAll("#sent .k2-slider-value")[1]?.textContent === "100");
    await reset(page);
    await page.evaluate(() => new Promise((done) => setTimeout(done, 50)));
    expect(await thumb.inputValue()).toBe("100");
    expect(await page.evaluate(() => document.querySelectorAll("#sent .k2-slider-value")[1]?.textContent)).toBe("100");
    expect(entriesOf((await sent(page)).entries, "zoom")).toEqual(["100"]);
  });
});

test("colour on black: a hue step says the hue core holds, not the black of the code", async () => {
  await withPage(async (page) => {
    await field(page, "Ton").getByRole("button", { name: "Farbe wählen" }).click();
    const hue = page.getByRole("slider", { name: "Farbton" });
    await hue.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#sent [aria-label="Farbton"]')].some((thumb) => thumb.getAttribute("aria-valuenow") === "1"),
    );
    expect(await hue.getAttribute("aria-valuetext")).toBe("1 Grad");
  });
});

test("colour: the swatch opens area and hue on a panel and says so; Escape closes it and gives the swatch the focus", async () => {
  await withPage(async (page) => {
    const accent = field(page, "Akzentfarbe");
    const swatch = accent.getByRole("button", { name: "Farbe wählen" });
    // closed, the row is one line: swatch and code, no area and no hue in the page
    expect(await page.getByRole("slider", { name: "Farbton" }).count()).toBe(0);
    expect(await swatch.getAttribute("aria-expanded")).toBe("false");
    await swatch.click();
    await page.getByRole("slider", { name: "Farbton" }).waitFor();
    expect(await swatch.getAttribute("aria-expanded")).toBe("true");
    await page.getByRole("slider", { name: "Farbton" }).focus();
    await page.keyboard.press("Escape");
    await page.getByRole("slider", { name: "Farbton" }).waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Farbe wählen");
  });
});

test("a form reads down one column: a field in a wide pane is at most 600 px wide", async () => {
  await withPage(async (page) => {
    const widths = await page.evaluate(() =>
      [...document.querySelectorAll(".k2-pane .k2-field")].map((element) => Math.round(element.getBoundingClientRect().width)),
    );
    expect(widths.length).toBeGreaterThan(5);
    expect(widths.filter((width) => width > 600)).toEqual([]);
  });
});

test("a disclosure head is a plain line: no frame, no fill, no padding of a native button", async () => {
  await withPage(async (page) => {
    const head = page.locator(".k2-disc-head").first();
    const look = await head.evaluate((element) => {
      const style = getComputedStyle(element);
      return { border: style.borderTopWidth, background: style.backgroundColor, appearance: style.appearance };
    });
    expect(look).toEqual({ border: "0px", background: "rgba(0, 0, 0, 0)", appearance: "none" });
  });
});

for (const width of [1440, 1024, 390])
  test(`layout at ${width} px: edges, lines, type roles and grips hold`, async () => {
    await withPage(async (page) => {
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect(layout.problems).toEqual([]);
    }, width);
  });
