import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-overlays.demo";
import { measureV2Layout } from "./testing";
import { heights, radii } from "./tokens";

// Dialog and Menu of v2 in a real engine, with v2.css: the boxes of the mockup (a dialog of 480 px in the middle, head
// and foot of 56 px, no line between its parts unless content scrolls behind them; on a small touch screen a sheet
// from the bottom; menu entries of 32 px), the layout rules of measureV2Layout while they are open, and the behaviour
// they promise (Escape, focus return).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
// Icons take one em without their font, so the layout does not depend on a font file in the test.
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  // The bundler resolves the entry beside the behaviour harness; ours lives one folder up in test/.
  [bundle, browser] = await Promise.all([demoBundle("../v2-overlays"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, { width = 1440, scale = 1, long = false, touch = false, two = false } = {}) => {
  // a phone: a touch screen with a coarse pointer
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: scale, hasTouch: touch, isMobile: touch });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"${long ? " data-long" : ""}${two ? " data-two" : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
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

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (!found) throw new Error("no box");
  return found;
};
const problems = async (page: Page, root: string) => (await measureV2Layout(page, { root })).problems;
const openDialog = async (page: Page) => {
  await page.getByRole("button", { name: "Abbrechen" }).click();
  await page.locator(".k2-dialog").waitFor();
  await settled(page);
};
// The line at the edge of a dialog part: its box-shadow, "none" when it has none.
const edge = (page: Page, slot: "head" | "foot") =>
  page.evaluate((s) => getComputedStyle(document.querySelector(`.k2-dialog > [data-slot="${s}"] > .k2-bar`) as Element).boxShadow, slot);

// A press beside an open overlay: a click, or on a touch screen a tap. Core dismisses after a tap on the click that
// follows it (so a scroll does not dismiss); Safari sends that click, Playwright's WebKit does not, so the test sends
// it where the engine did not.
declare global {
  interface Window {
    __k2Clicks?: number;
  }
}
const pressOutside = async (page: Page, touch: boolean) => {
  if (!touch) return page.mouse.click(8, 8);
  const [x, y] = [195, 20];
  await page.evaluate(() => {
    window.__k2Clicks = 0;
    addEventListener("click", () => window.__k2Clicks!++, { capture: true, once: true });
  });
  await page.touchscreen.tap(x, y);
  // the click an engine sends with a tap has arrived once the page settled
  await settled(page);
  await page.evaluate(
    ([x, y]) => {
      if (window.__k2Clicks) return;
      document
        .elementFromPoint(x, y)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, detail: 1 }));
    },
    [x, y] as const,
  );
};

for (const scale of [1, 2]) {
  test(`dialog at DPR ${scale}: 480 px in the middle, head and foot 56 px, one surface without lines`, async () => {
    await withPage(
      async (page) => {
        await openDialog(page);
        const dialog = await box(page.locator(".k2-dialog"));
        expect(dialog.width).toBe(480);
        expect(Math.abs(dialog.x + dialog.width / 2 - 720)).toBeLessThanOrEqual(1);
        expect(Math.abs(dialog.y + dialog.height / 2 - 450)).toBeLessThanOrEqual(1);
        expect((await box(page.locator('.k2-dialog > [data-slot="head"] > .k2-bar'))).height).toBe(heights.head);
        expect((await box(page.locator('.k2-dialog > [data-slot="foot"] > .k2-bar'))).height).toBe(heights.head);
        expect(await page.locator(".k2-dialog").getAttribute("data-more")).toBeNull();
        expect(await edge(page, "head")).toBe("none");
        expect(await edge(page, "foot")).toBe("none");
        expect(await problems(page, ".k2-dialog")).toEqual([]);
        // the close button stands with its icon on the text edge: 28 px, its right side 10 px past the edge of 20
        const close = await box(page.locator('.k2-dialog > [data-slot="head"] .k2-btn'));
        expect([close.width, close.height, dialog.x + dialog.width - (close.x + close.width)]).toEqual([28, 28, 10]);
        expect((await box(page.locator(".k2-backdrop"))).width).toBe(1440);
      },
      { scale },
    );
  });
}

test("dialog: Escape closes it and focus returns to the button that opened it", async () => {
  await withPage(async (page) => {
    await openDialog(page);
    const inside = () => page.evaluate(() => document.querySelector(".k2-dialog")?.contains(document.activeElement));
    expect(await inside()).toBe(true);
    // Tab and Shift+Tab go round inside the dialog: close, the two buttons of the foot, and back
    for (const key of ["Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      expect(await inside()).toBe(true);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".k2-dialog"));
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Abbrechen");
  });
});

test("dialog with more content than fits: it scrolls, and a line shows only at the edge behind which content lies", async () => {
  await withPage(
    async (page) => {
      await openDialog(page);
      const dialog = page.locator(".k2-dialog");
      expect((await box(dialog)).height).toBeLessThanOrEqual(900 - 64);
      expect(await dialog.getAttribute("data-more")).toBe("below");
      expect(await edge(page, "head")).toBe("none");
      expect(await edge(page, "foot")).not.toBe("none");
      await page.locator(".k2-dialog-body").evaluate((body) => body.scrollTo({ top: body.scrollHeight }));
      await page.waitForFunction(() => document.querySelector(".k2-dialog")?.getAttribute("data-more") === "above");
      expect(await edge(page, "head")).not.toBe("none");
      expect(await edge(page, "foot")).toBe("none");
    },
    { long: true },
  );
});

// A narrow window without touch (a small desktop window) keeps the dialog form, 16 px from the window's edges.
// One line for the phone: where v2 lays out the phone (below 768 px), the dialog is a sheet, with or without touch (an
// iPad mini upright, a phone across); from 768 px on it is the dialog in the middle.
for (const width of [767, 768])
  test(`a window of ${width} px without touch: ${width < 768 ? "the sheet of the phone" : "the dialog in the middle"}`, async () => {
    await withPage(
      async (page) => {
        await openDialog(page);
        const dialog = page.locator(".k2-dialog");
        expect(await dialog.getAttribute("data-presentation")).toBe(width < 768 ? "sheet" : "dialog");
        const found = await box(dialog);
        expect([found.x, found.width]).toEqual(width < 768 ? [0, width] : [(width - 480) / 2, 480]);
        expect(await problems(page, ".k2-dialog")).toEqual([]);
      },
      { width },
    );
  });

// The open list of a selection (Bausteine 09): exactly as wide as its field, an option per row of 32 px, a check at the
// chosen option; the keyboard and the form work.
for (const width of [1440, 390]) {
  test(`select at ${width}: the list is as wide as its field, the chosen option has the check, the choice reaches the form`, async () => {
    await withPage(
      async (page) => {
        const trigger = page.locator('[data-k2-part="Select"]').first();
        expect((await box(trigger)).height).toBe(heights.control);
        // the field's label names the selection (the behaviour layer owns the trigger's id, so it is aria-labelledby)
        expect(await page.getByRole("combobox", { name: "Art" }).count()).toBe(1);
        expect(await page.locator('.k2-field-label[for]:has-text("Art")').count()).toBe(0);
        await trigger.click();
        const list = page.locator(".k2-menu[data-listbox]");
        await list.waitFor();
        await settled(page);
        const [field, popup] = [await box(trigger), await box(list)];
        expect([popup.x, popup.width]).toEqual([field.x, field.width]);
        expect(await list.locator(".k2-mi").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))).toEqual([
          32, 32, 32,
        ]);
        // the check stands only at the chosen option, at the end of its row
        const checks = await list.locator(".k2-mi").evaluateAll((items) =>
          items.map((item) => {
            const mark = item.querySelector(".k2-mi-meta");
            return !!mark && mark.getClientRects().length > 0;
          }),
        );
        expect(checks).toEqual([true, false, false]);
        expect(await problems(page, "body")).toEqual([]);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await list.waitFor({ state: "hidden" });
        expect(await trigger.textContent()).toContain("Reparatur");
        expect(await page.locator('input[name="kind"]').inputValue()).toBe("Reparatur");
      },
      { width },
    );
  });
}

// The value of a selection lives in core's form input: a required selection blocks a submit while empty, a choice
// fires `change`, and the form's reset puts every selection back to the value it started with.
test("select in a form: required blocks an empty submit, a choice fires change, reset puts it back", async () => {
  await withPage(async (page) => {
    // the page in a form, as an app's form holds its fields
    await page.evaluate(() => {
      const form = document.createElement("form");
      const root = document.getElementById("root")!;
      root.replaceWith(form);
      form.append(root);
      (window as unknown as { __changes: string[] }).__changes = [];
      form.addEventListener("change", (event) =>
        (window as unknown as { __changes: string[] }).__changes.push((event.target as HTMLInputElement).name),
      );
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        document.body.dataset.sent = "";
      });
    });
    const submit = () => page.evaluate(() => document.querySelector("form")!.requestSubmit());
    const valid = () => page.evaluate(() => document.querySelector("form")!.checkValidity());
    expect(await valid()).toBe(false);
    await submit();
    expect(await page.evaluate(() => "sent" in document.body.dataset)).toBe(false);
    const choose = async (field: string, option: string) => {
      await page.getByRole("combobox", { name: field }).click();
      await page.locator(`.k2-menu[data-listbox]:visible .k2-mi:has-text("${option}")`).click();
      await page
        .locator(".k2-menu[data-listbox]:visible")
        .waitFor({ state: "detached" })
        .catch(() => undefined);
      await settled(page);
    };
    await choose("Material", "Buche");
    await choose("Art", "Montage");
    expect(await page.locator('input[name="material"]').inputValue()).toBe("Buche");
    expect(await page.evaluate(() => (window as unknown as { __changes: string[] }).__changes)).toEqual(["material", "kind"]);
    expect(await valid()).toBe(true);
    await submit();
    expect(await page.evaluate(() => "sent" in document.body.dataset)).toBe(true);
    // a selection that holds its own choice goes back; one whose caller holds the value (`onChange`) keeps it, as a
    // controlled field does
    await page.evaluate(() => document.querySelector("form")!.reset());
    await settled(page);
    expect(await page.locator('input[name="material"]').inputValue()).toBe("");
    expect(await page.getByRole("combobox", { name: "Material" }).textContent()).toContain("Wählen");
    expect(await valid()).toBe(false);
  });
});

// Dialog.confirm always answers: with two Workspaces on a page the first one answers, the second one takes over when the
// first leaves, and without any Workspace the answer is no at once.
test("Dialog.confirm with two Workspaces: one answers, the other takes over, none answers no", async () => {
  await withPage(
    async (page) => {
      const ask = async (agree: boolean) => {
        await page.evaluate(() => {
          delete document.body.dataset.answer;
          window.__k2Ask?.();
        });
        const dialog = page.getByRole("alertdialog", { name: "Weiter?" });
        await dialog.waitFor();
        expect(await page.locator(".k2-dialog").count()).toBe(1);
        if (agree) await dialog.getByRole("button", { name: "Ja" }).click();
        else await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.body.dataset.answer !== undefined);
        return page.evaluate(() => document.body.dataset.answer);
      };
      expect(await ask(true)).toBe("true");
      // the second one leaves: the first still answers
      await page.evaluate(() => window.__k2Drop?.(2));
      expect(await ask(false)).toBe("false");
      // the first one leaves too: nobody answers, and the question is answered no at once
      await page.evaluate(() => window.__k2Drop?.(1));
      await page.evaluate(() => {
        delete document.body.dataset.answer;
        window.__k2Ask?.();
      });
      await page.waitForFunction(() => document.body.dataset.answer === "false");
    },
    { two: true },
  );
  // the first one leaves first: the second takes over
  await withPage(
    async (page) => {
      await page.evaluate(() => window.__k2Drop?.(1));
      await page.evaluate(() => window.__k2Ask?.());
      const dialog = page.getByRole("alertdialog", { name: "Weiter?" });
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Ja" }).click();
      await page.waitForFunction(() => document.body.dataset.answer === "true");
    },
    { two: true },
  );
});

// The value of a selection is set like the value of an input (the mockup's `.k-input` holds both): the same type, and
// its line at the same height in the same 36 px box.
test("select: its value has the type and the place of an input's value", async () => {
  await withPage(async (page) => {
    const [input, select] = await page.evaluate(() => {
      const field = (name: string) => [...document.querySelectorAll(".k2-field")].find((found) => found.textContent?.startsWith(name))!;
      const input = field("Kunde").querySelector("input")!;
      const value = field("Zahler").querySelector(".k2-input-value")!;
      const line = (element: Element, top: number) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        // an input centres its one line in its box; the selection's line box is its own box
        const offset = element instanceof HTMLInputElement ? (box.height - Number.parseFloat(style.lineHeight)) / 2 : 0;
        return { font: [style.fontSize, style.lineHeight, style.fontWeight, style.fontFamily].join(" "), top: box.top + offset - top };
      };
      return [line(input, input.parentElement!.getBoundingClientRect().top), line(value, value.parentElement!.getBoundingClientRect().top)];
    });
    expect(select).toEqual(input);
  });
});

// Typeahead: with the list open, typing the start of an option highlights it, Enter chooses it.
test("select: typing the start of an option chooses it with Enter", async () => {
  await withPage(async (page) => {
    const art = page.getByRole("combobox", { name: "Art" });
    await art.click();
    await page.locator(".k2-menu[data-listbox]").waitFor();
    await page.keyboard.type("Mo");
    await page.keyboard.press("Enter");
    await page.locator(".k2-menu[data-listbox]").waitFor({ state: "hidden" });
    expect(await art.textContent()).toContain("Montage");
  });
});

// A press on a selection's label focuses the selection, as a label does for its control.
test("select: its label focuses it", async () => {
  await withPage(async (page) => {
    await page.locator('.k2-field-label:has-text("Material")').click();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("combobox");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Wählen");
  });
});

// The mockup: "a dialog, on the phone a sheet". On a small touch screen core presents it as a sheet from the bottom:
// the whole width, its top corners round, at the bottom of the window; Escape still closes it.
test("dialog on a phone: a sheet from the bottom, the whole width, its top corners round", async () => {
  await withPage(
    async (page) => {
      await openDialog(page);
      const dialog = page.locator(".k2-dialog");
      expect(await dialog.getAttribute("data-presentation")).toBe("sheet");
      const sheet = await box(dialog);
      expect([sheet.x, sheet.width, Math.round(sheet.y + sheet.height)]).toEqual([0, 390, 900]);
      const radius = await dialog.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius];
      });
      expect(radius).toEqual([`${radii.overlay}px`, `${radii.overlay}px`, "0px", "0px"]);
      expect((await box(page.locator('.k2-dialog > [data-slot="head"] > .k2-bar'))).height).toBe(heights.head);
      expect(await problems(page, ".k2-dialog")).toEqual([]);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".k2-dialog"));
    },
    { width: 390, touch: true },
  );
});

// Dialog.confirm (the concept's question before something that cannot be taken back): an alert dialog in the shape of
// Dialog, rendered by Workspace. No close button; focus starts on the other button, Escape and that button answer no,
// a press outside does nothing, the agreeing button answers yes, and it is never a sheet.
for (const touch of [false, true])
  test(`Dialog.confirm${touch ? " on a phone" : ""}: an alert dialog that answers yes or no`, async () => {
    await withPage(
      async (page) => {
        const ask = async () => {
          await page.getByRole("button", { name: "Löschen", exact: true }).click();
          await page.getByRole("alertdialog", { name: "Auftrag löschen?" }).waitFor();
          await settled(page);
        };
        const answer = () => page.getByText(/^Antwort: /).textContent();
        await ask();
        const dialog = page.locator(".k2-dialog[data-alert]");
        expect(await dialog.getAttribute("data-presentation")).not.toBe("sheet");
        expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Abbrechen");
        expect(await page.locator('.k2-dialog[data-alert] > [data-slot="head"] .k2-btn').count()).toBe(0);
        expect(await problems(page, ".k2-dialog")).toEqual([]);
        // a press outside does not answer
        await page.mouse.click(4, 4);
        await settled(page);
        expect(await dialog.count()).toBe(1);
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.querySelector(".k2-dialog"));
        expect(await answer()).toBe("Antwort: nein");
        await ask();
        await page.getByRole("button", { name: "Löschen", exact: true }).last().click();
        await page.waitForFunction(() => document.body.textContent?.includes("Antwort: ja"));
        expect(await answer()).toBe("Antwort: ja");
      },
      touch ? { width: 390, touch } : {},
    );
  });

// The first field of a dialog takes the focus, not the close button of its head; without a field the first action of
// its foot does. Title and foot follow their props while it is open (a key that was just made).
test("dialog: the first field takes the focus, title and foot follow their props; without a field the first action of the foot", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Zugang anlegen" }).click();
    await page.locator('.k2-dialog:has-text("Neuer Zugang")').waitFor();
    await settled(page);
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value)).toBe("k2b_live_7Q4mX9");
    // title and foot follow their props while the dialog is open, and the dialog keeps its name
    await page.getByRole("button", { name: "Anlegen", exact: true }).click();
    await page.getByRole("dialog", { name: "Zugang erstellt" }).waitFor();
    expect(await page.locator(".k2-dialog-title").textContent()).toBe("Zugang erstellt");
    expect(await page.getByRole("button", { name: "Anlegen", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Fertig" }).click();
    await page.waitForFunction(() => !document.querySelector(".k2-dialog"));
    await openDialog(page);
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Weiter bearbeiten");
  });
});

// `dismissible={false}` (a secret shown once): a press outside, on the phone a tap on the backdrop, does not close it;
// Escape and its own buttons do, and the focus returns.
for (const touch of [false, true])
  test(`dialog that is not dismissible${touch ? " on a phone" : ""}: an outside press keeps it, Escape closes it`, async () => {
    await withPage(
      async (page) => {
        const open = async () => {
          await page.getByRole("button", { name: "Zugang anlegen" }).click();
          await page.locator('.k2-dialog:has-text("Neuer Zugang")').waitFor();
          await settled(page);
        };
        await open();
        expect(await page.locator(".k2-dialog").getAttribute("data-presentation")).toBe(touch ? "sheet" : "dialog");
        await pressOutside(page, touch);
        await settled(page);
        expect(await page.locator(".k2-dialog").count()).toBe(1);
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.querySelector(".k2-dialog"));
        expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Zugang anlegen");
        // the default dialog still closes on a press outside
        await openDialog(page);
        await pressOutside(page, touch);
        await page.waitForFunction(() => !document.querySelector(".k2-dialog"));
      },
      touch ? { width: 390, touch } : {},
    );
  });
