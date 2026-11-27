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
    await page.getByRole("button", { name: "werkstatt.example entfernen", exact: true }).click();
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

/** Pastes text into a field's input, where its selection stands, as a person's paste does. */
const paste = (input: ReturnType<Page["locator"]>, text: string) =>
  input.evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData("text/plain", pasted);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);

test("addresses: Enter, a comma or a paste turn addresses into chips, with quoted names too; a wrong one stays, with its reason", async () => {
  await withPage(async (page) => {
    const to = field(page, "An");
    const input = to.getByRole("combobox");
    const chips = () => to.locator(".k2-chip").evaluateAll((list) => list.map((chip) => chip.firstChild?.textContent ?? ""));
    expect(await input.getAttribute("inputmode")).toBe("email");
    // a comma ends an address
    await input.fill("");
    await input.pressSequentially("jonas@werkstatt.example,");
    await to.locator(".k2-chip").nth(1).waitFor();
    expect(await chips()).toEqual(["anna.berg@werkstatt.example", "jonas@werkstatt.example"]);
    expect(await input.inputValue()).toBe("");
    // a name being typed is no address yet: its comma stays as typed
    await input.pressSequentially("Mia Lindqvist,");
    expect(await input.inputValue()).toBe("Mia Lindqvist,");
    await input.fill("");
    // a paste: quoted names with a comma, a name with a comma before its <…>, the same address in other letters, and a
    // wrong one, which stays with its own separators and a sentence that keeps the form from being sent
    await paste(
      input,
      '"Lindqvist, Mia" <mia@lindqvist.example>; Berg, Paul <paul@werkstatt.example>\nANNA.BERG@werkstatt.example, kein-at-zeichen',
    );
    await to.locator(".k2-chip").nth(3).waitFor();
    expect(await chips()).toEqual([
      "anna.berg@werkstatt.example",
      "jonas@werkstatt.example",
      '"Lindqvist, Mia" <mia@lindqvist.example>',
      "Berg, Paul <paul@werkstatt.example>",
    ]);
    expect(await input.inputValue()).toBe("kein-at-zeichen");
    expect(await input.getAttribute("aria-invalid")).toBe("true");
    const reason = "„kein-at-zeichen“ ist keine E-Mail-Adresse.";
    expect(await to.locator(".k2-field-message[data-error]").textContent()).toBe(reason);
    expect(await input.evaluate((element) => (element as HTMLInputElement).validationMessage)).toBe(reason);
    expect((await sent(page)).valid).toBe(false);
    expect(await to.getByRole("status").textContent()).toBe("2 Adressen hinzugefügt.");
    // fixing it: the sentence goes while the text is edited
    await input.press("End");
    await input.press("Backspace");
    expect(await to.locator(".k2-field-message").count()).toBe(0);
    expect(await input.getAttribute("aria-invalid")).toBeNull();
    // a paste over a selection replaces it
    await input.fill("Hallo");
    await input.evaluate((element) => (element as HTMLInputElement).setSelectionRange(0, 5));
    await paste(input, "kai@werkstatt.example, lea@werkstatt.example");
    await to.locator(".k2-chip").nth(5).waitFor();
    expect(await input.inputValue()).toBe("");
    // each chip is sent, and taken away with its named button or with Backspace in the empty field
    expect(entriesOf((await sent(page)).entries, "to")).toHaveLength(6);
    await to.getByRole("button", { name: "jonas@werkstatt.example entfernen" }).click();
    await input.press("Backspace");
    await page.waitForFunction(() => !document.querySelector('.k2-chip-x[aria-label="lea@werkstatt.example entfernen"]'));
    expect(entriesOf((await sent(page)).entries, "to")).toHaveLength(4);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role="status"]')].some((status) => status.textContent === "1 Adresse entfernt."),
    );
    // the form's reset puts the first address back
    await reset(page);
    await page.waitForFunction(() => document.querySelectorAll('input[type="hidden"][name="to"]').length === 1);
  });
});

test("addresses: a field takes no more than it may, and says so beside a refused text; values of every kind", async () => {
  await withPage(async (page) => {
    const cc = field(page, "Kopie");
    const input = cc.getByRole("combobox");
    // five addresses and a wrong text: three are taken, and both sentences stand under the chips
    await paste(input, "a@werkstatt.example, b@werkstatt.example, c@werkstatt.example, d@werkstatt.example, e@werkstatt.example, kaputt");
    await cc.locator(".k2-chip").nth(2).waitFor();
    expect(await cc.locator(".k2-chip").count()).toBe(3);
    expect(await cc.locator(".k2-field-message").textContent()).toBe(
      "„kaputt“ ist keine E-Mail-Adresse. Dieses Feld nimmt höchstens 3 Adressen; 2 wurden nicht übernommen.",
    );
    // a long wrong text is named in short in the sentence
    await input.fill("");
    await paste(input, `${"x".repeat(100)}, f@werkstatt.example`);
    const said = (await cc.locator(".k2-field-message[data-error]").textContent()) ?? "";
    const quoted = said.slice(said.indexOf("„") + 1, said.indexOf("“"));
    expect(quoted.endsWith("…")).toBe(true);
    expect(quoted.length).toBe(60);
    // removing the last chip there is: the focus goes to the field
    await input.fill("");
    for (const name of ["c", "b"]) await cc.getByRole("button", { name: `${name}@werkstatt.example entfernen` }).click();
    await cc.getByRole("button", { name: "a@werkstatt.example entfernen" }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "combobox");
    // a field of other values keeps its own limit too
    const hosts = page.getByRole("combobox", { name: "Server", exact: true });
    await hosts.click();
    await page.keyboard.type("mx2.example");
    await page.keyboard.press("Enter");
    await page.keyboard.type("mx3.example");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".k2-field-message")].some((message) => message.textContent?.includes("höchstens 2 Werte")),
    );
    expect(entriesOf((await sent(page)).entries, "hosts")).toEqual(["mx1.example", "mx2.example"]);
    // what is left out is not held anywhere: Backspace in the empty field takes back the last chip that shows
    await page.keyboard.press("Backspace");
    await page.waitForFunction(() => document.querySelectorAll('input[type="hidden"][name="hosts"]').length === 1);
    expect(entriesOf((await sent(page)).entries, "hosts")).toEqual(["mx1.example"]);
  });
});

test("addresses: a press beside the open suggestions takes the typed address", async () => {
  await withPage(async (page) => {
    const bcc = field(page, "Weitere Empfänger");
    const input = bcc.getByRole("combobox");
    await input.click();
    await input.pressSequentially("tom@werkstatt.examp");
    await page.getByRole("option", { name: "tom@werkstatt.example" }).waitFor();
    // a press somewhere else on the page: the typed address becomes a chip, it is not lost
    await page.mouse.click(4, 4);
    await bcc.locator(".k2-chip").first().waitFor();
    expect(await bcc.locator(".k2-chip").evaluateAll((list) => list.map((chip) => chip.firstChild?.textContent))).toEqual([
      "tom@werkstatt.examp",
    ]);
    expect(await input.inputValue()).toBe("");
  });
});

test("addresses: sending with the focus in the field sends the typed address, and keeps a text that is no address", async () => {
  await withPage(async (page) => {
    await field(page, "Banner")
      .locator('input[type="file"]')
      .setInputFiles({ name: "b.png", mimeType: "image/png", buffer: Buffer.from("b") });
    await field(page, "Banner").locator(".k2-image-preview > img").waitFor();
    const to = field(page, "An").getByRole("combobox");
    await to.click();
    await to.pressSequentially("kai@werkstatt.example");
    const submitted = () =>
      page.evaluate(() => {
        const form = document.getElementById("sent");
        if (!(form instanceof HTMLFormElement)) return null;
        const seen: { to?: string[] } = {};
        const hear = () => {
          seen.to = [...new FormData(form)].filter(([name]) => name === "to").map(([, value]) => String(value));
        };
        form.addEventListener("submit", hear);
        form.requestSubmit();
        form.removeEventListener("submit", hear);
        return seen.to ?? null;
      });
    expect(await submitted()).toEqual(["anna.berg@werkstatt.example", "kai@werkstatt.example"]);
    expect(await to.inputValue()).toBe("");
    // a text that is no address is not sent: it stays with its reason
    await to.focus();
    await to.pressSequentially("kaputt");
    expect(await submitted()).toBeNull();
    expect(await to.inputValue()).toBe("kaputt");
    expect(await field(page, "An").locator(".k2-field-message[data-error]").textContent()).toBe("„kaputt“ ist keine E-Mail-Adresse.");
  });
});

test("addresses: while typing, an address is taken once a separator, Enter or leaving the field closes it; the same news is said again", async () => {
  await withPage(async (page) => {
    const to = field(page, "An");
    const input = to.getByRole("combobox");
    await input.fill("");
    // a name with a comma and an address still being typed: nothing is taken yet
    await input.pressSequentially("Mia Lindqvist, mia@lindqvist.e");
    expect(await to.locator(".k2-chip").count()).toBe(1);
    expect(await input.inputValue()).toBe("Mia Lindqvist, mia@lindqvist.e");
    await input.fill("kai@werkstatt.example");
    // leaving the field takes it
    await page.keyboard.press("Tab");
    await to.locator(".k2-chip").nth(1).waitFor();
    // the status is emptied before each news, so \"1 Adresse hinzugefügt.\" twice is heard twice
    await to.locator('.k2-hidden-text[role="status"]').evaluate((status) => {
      Reflect.set(window, "__k2Said", 0);
      new MutationObserver(() => {
        if (status.textContent) Reflect.set(window, "__k2Said", Number(Reflect.get(window, "__k2Said")) + 1);
      }).observe(status, { childList: true, characterData: true, subtree: true });
    });
    for (const address of ["lea@werkstatt.example, ", "tom@werkstatt.example, "]) await paste(input, address);
    await page.waitForFunction(() => Number(Reflect.get(window, "__k2Said")) >= 2);
  });
});

test("chip: its remove button is named for what it removes and takes it away, also from the keyboard, and the focus goes on", async () => {
  await withPage(async (page) => {
    const remove = page.getByRole("button", { name: "Anna Berg entfernen" });
    expect(await remove.count()).toBe(1);
    await remove.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window.__deeds ?? []).includes("unassign:Anna Berg"));
    expect(await page.getByRole("button", { name: "Anna Berg entfernen" }).count()).toBe(0);
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Jonas Wolf entfernen");
  });
});

test("tags: named by their field's label; a form's reset puts the uncontrolled list back", async () => {
  await withPage(async (page) => {
    const input = page.getByRole("combobox", { name: "Server", exact: true });
    expect(await input.count()).toBe(1);
    await input.click();
    await page.keyboard.type("mx2.example");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelectorAll('#sent [data-tags]:has(.k2-chip-x[aria-label^="mx"]) > .k2-chip').length === 3,
    );
    expect(entriesOf((await sent(page)).entries, "hosts")).toEqual(["mx1.example", "mx2.example"]);
    await reset(page);
    await page.waitForFunction(
      () => document.querySelectorAll('#sent [data-tags]:has(.k2-chip-x[aria-label^="mx"]) > .k2-chip').length === 2,
    );
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
