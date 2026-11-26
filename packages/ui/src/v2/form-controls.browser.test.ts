import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, heard, serverMarkup } from "../../test/v2-behavior/harness";
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
    const hue = accent.getByRole("slider", { name: "Farbton" });
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
    expect(files(form.entries.filter((entry) => entry.name === "banner"))).toEqual([]);
    // the image is required and still empty: the form is not valid
    expect(entriesOf(form.entries, "banner")).toEqual([""]);
    expect(form.valid).toBe(false);
    await field(page, "Banner")
      .locator('input[type="file"]')
      .setInputFiles({ name: "b.png", mimeType: "image/png", buffer: Buffer.from("b") });
    await field(page, "Banner").locator(".k2-image-preview > img").waitFor();
    form = await sent(page);
    expect(entriesOf(form.entries, "banner")).toEqual(["data:text/plain,b"]);
    expect(files(form.entries.filter((entry) => entry.name === "banner"))).toEqual([]);
    // with the documents the form asks for, the form is complete
    await field(page, "Unterlagen")
      .locator('input[type="file"]')
      .setInputFiles({ name: "a.pdf", mimeType: "application/pdf", buffer: Buffer.from("a") });
    await page.waitForFunction(() => document.querySelectorAll("#sent .k2-files-row").length === 1);
    expect((await sent(page)).valid).toBe(true);
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
    // the image's own check (the form holds other required fields too)
    const imageValid = () =>
      field(page, "Banner")
        .locator('input[type="file"]')
        .evaluate((input) => (input instanceof HTMLInputElement ? input.checkValidity() : false));
    expect(await imageValid()).toBe(false);
    await page.evaluate(() => Reflect.get(window, "__k2Open")?.());
    await field(page, "Banner").locator(".k2-image-preview > img").waitFor();
    expect(await imageValid()).toBe(true);
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

test("files: chosen files are listed with type and size, sent with the form, required, removed by button or key, put back on reset", async () => {
  await withPage(async (page) => {
    const docs = field(page, "Unterlagen");
    expect((await sent(page)).valid).toBe(false);
    await docs.locator('input[type="file"]').setInputFiles([
      { name: "angebot.pdf", mimeType: "application/pdf", buffer: Buffer.from("pdf") },
      {
        name: "brief.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: Buffer.from("doc"),
      },
    ]);
    const rows = docs.getByRole("listitem");
    await page.waitForFunction(() => document.querySelectorAll("#sent .k2-files-row").length === 2);
    expect(await rows.locator(".k2-files-name").allTextContents()).toEqual(["angebot.pdf", "brief.docx"]);
    expect(await rows.locator(".k2-files-size").allTextContents()).toEqual(["3 Byte", "3 Byte"]);
    expect(await rows.locator(".k2-icon").evaluateAll((icons) => icons.map((icon) => icon.getAttribute("data-name")))).toEqual([
      "file-type-pdf",
      "x",
      "file-type-doc",
      "x",
    ]);
    expect(entriesOf((await sent(page)).entries, "docs")).toEqual(["file:angebot.pdf", "file:brief.docx"]);
    // a press on the remove button: the form sends the other file only, then Delete on the focused row
    await docs.getByRole("button", { name: "angebot.pdf entfernen" }).click();
    await page.waitForFunction(() => document.querySelectorAll("#sent .k2-files-row").length === 1);
    expect(entriesOf((await sent(page)).entries, "docs")).toEqual(["file:brief.docx"]);
    await rows.first().focus();
    await page.keyboard.press("Delete");
    await page.waitForFunction(() => document.querySelectorAll("#sent .k2-files-row").length === 0);
    // picked again, then the form's reset empties the field
    await docs.locator('input[type="file"]').setInputFiles({ name: "c.pdf", mimeType: "application/pdf", buffer: Buffer.from("c") });
    await page.waitForFunction(() => document.querySelectorAll("#sent .k2-files-row").length === 1);
    await reset(page);
    await page.waitForFunction(() => document.querySelectorAll("#sent .k2-files-row").length === 0);
    expect(entriesOf((await sent(page)).entries, "docs").filter((value) => value !== "file:")).toEqual([]);
  });
});

test("files: a file of the wrong type or too large is refused with a sentence at the field", async () => {
  await withPage(async (page) => {
    const source = field(page, "Dokument");
    const input = source.locator('input[type="file"]');
    const hint = source.locator(".k2-files-hint");
    const trigger = source.getByRole("button", { name: "Datei wählen" });
    const before = await source.boundingBox();
    await input.setInputFiles({ name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from("x") });
    await source.locator(".k2-files-hint[data-refused]").waitFor();
    expect(await hint.textContent()).toBe("setup.exe hat keinen Dateityp, den dieses Feld nimmt.");
    // the sentence describes the button, marks it invalid, stands in the hint's place (nothing moves) and is heard once
    expect(await trigger.evaluate((el) => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent)).toBe(
      "setup.exe hat keinen Dateityp, den dieses Feld nimmt.",
    );
    expect(await trigger.getAttribute("aria-invalid")).toBe("true");
    expect((await source.boundingBox())?.height).toBe(before?.height);
    expect(await source.getByRole("alert").count()).toBe(0);
    await input.setInputFiles({ name: "gross.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(4096) });
    await page.waitForFunction(() => document.querySelector("#sent .k2-files-hint[data-refused]")?.textContent?.startsWith("gross.pdf"));
    expect(await hint.textContent()).toBe("gross.pdf ist größer als 2 kB.");
    await input.setInputFiles({ name: "notiz.md", mimeType: "text/markdown", buffer: Buffer.from("# x") });
    await source.locator(".k2-files-hint[data-refused]").waitFor({ state: "detached" });
    expect(await source.locator(".k2-files-name").allTextContents()).toEqual(["notiz.md"]);
    expect(await trigger.getAttribute("aria-invalid")).toBeNull();
  });
});

test("files: two files of the same name stay two rows; a dropped folder is refused with a sentence", async () => {
  await withPage(async (page) => {
    const docs = field(page, "Unterlagen");
    await docs.locator('input[type="file"]').setInputFiles([
      { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from("1") },
      { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from("2") },
    ]);
    await page.waitForFunction(() => document.querySelectorAll("#sent .k2-files-row").length === 2);
    // a folder dropped on the field: the browser hands over an entry that is a folder, with files inside
    await docs.locator(".k2-files-drop").evaluate((zone) => {
      const file = new File(["x"], "beleg.pdf", { type: "application/pdf" });
      const fileEntry = { isFile: true, isDirectory: false, fullPath: "/Belege/beleg.pdf", file: (done: (f: File) => void) => done(file) };
      let read = false;
      const folder = {
        isFile: false,
        isDirectory: true,
        fullPath: "/Belege",
        createReader: () => ({
          readEntries: (done: (entries: unknown[]) => void) => {
            done(read ? [] : [fileEntry]);
            read = true;
          },
        }),
      };
      const items = [{ kind: "file", type: "", getAsFile: () => null, webkitGetAsEntry: () => folder }];
      const transfer = { items, files: [], types: ["Files"], dropEffect: "copy", effectAllowed: "all" };
      for (const type of ["dragenter", "dragover", "drop"]) {
        const event = new DragEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: transfer });
        zone.dispatchEvent(event);
      }
    });
    await page.waitForFunction(() => document.querySelector("#sent .k2-files-hint[data-refused]"));
    expect(await docs.locator(".k2-files-hint").textContent()).toBe("Dieses Feld nimmt Dateien, keine Ordner. Wähle die Dateien darin.");
    expect(await docs.locator(".k2-files-name").allTextContents()).toEqual(["scan.pdf", "scan.pdf"]);
  });
});

/** Drops entries on a field's drop zone as a browser hands them over: plain files and folders with files inside. */
const dropEntries = (zone: ReturnType<Page["locator"]>, entries: { folder?: string; name: string; type: string }[]) =>
  zone.evaluate((element, list) => {
    const items = list.map((entry) => {
      const file = new File(["x"], entry.name, { type: entry.type });
      const fileEntry = {
        isFile: true,
        isDirectory: false,
        fullPath: entry.folder ? `/${entry.folder}/${entry.name}` : `/${entry.name}`,
        file: (done: (f: File) => void) => done(file),
      };
      let read = false;
      const folder = entry.folder && {
        isFile: false,
        isDirectory: true,
        fullPath: `/${entry.folder}`,
        createReader: () => ({
          readEntries: (done: (entries: unknown[]) => void) => {
            done(read ? [] : [fileEntry]);
            read = true;
          },
        }),
      };
      return { kind: "file", type: entry.type, getAsFile: () => (folder ? null : file), webkitGetAsEntry: () => folder || fileEntry };
    });
    const transfer = { items, files: [], types: ["Files"], dropEffect: "copy", effectAllowed: "all" };
    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = new DragEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      element.dispatchEvent(event);
    }
  }, entries);

test("files: a refusal sentence goes when the form is reset or the page empties the field, without a change of files", async () => {
  await withPage(async (page) => {
    // the form's own field: refused, then the form's reset (the field was empty and stays empty)
    const source = field(page, "Dokument");
    await source
      .locator('input[type="file"]')
      .setInputFiles({ name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from("x") });
    await source.locator(".k2-files-hint[data-refused]").waitFor();
    await reset(page);
    await source.locator(".k2-files-hint[data-refused]").waitFor({ state: "detached" });
    expect(await source.getByRole("button", { name: "Datei wählen" }).getAttribute("aria-invalid")).toBeNull();
    // a field the page holds: a file taken, a refusal, then the page empties it (as after "Umwandeln")
    const template = field(page, "Vorlage");
    const input = template.locator('input[type="file"]');
    await input.setInputFiles({ name: "vorlage.pdf", mimeType: "application/pdf", buffer: Buffer.from("v") });
    await template.locator(".k2-files-name").waitFor();
    await input.setInputFiles({ name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from("x") });
    await template.locator(".k2-files-hint[data-refused]").waitFor();
    // a file taken and one refused in one pick: the page's copy of the list is no change, the sentence stays
    await input.setInputFiles([
      { name: "anlage.pdf", mimeType: "application/pdf", buffer: Buffer.from("a") },
      { name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from("x") },
    ]);
    await template.locator(".k2-files-name").nth(1).waitFor();
    await settled(page);
    expect(await template.locator(".k2-files-hint[data-refused]").count()).toBe(1);
    await page.evaluate(() => window.__k2ClearTemplate?.());
    await template.locator(".k2-files-name").waitFor({ state: "detached" });
    expect(await template.locator(".k2-files-hint[data-refused]").count()).toBe(0);
  });
});

test("files: what is heard reads as sentences, and a dropped folder is named before a refused file beside it", async () => {
  await withPage(async (page) => {
    const docs = field(page, "Unterlagen");
    await docs.locator('input[type="file"]').setInputFiles([
      { name: "angebot.pdf", mimeType: "application/pdf", buffer: Buffer.from("a") },
      { name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from("x") },
    ]);
    expect(await heard(page, "1 Datei gewählt. setup.exe hat keinen Dateityp, den dieses Feld nimmt.")).toBe(true);
    // a text file first, then a folder: the folder is what the person has to change
    await dropEntries(docs.locator(".k2-files-drop"), [
      { name: "notiz.txt", type: "text/plain" },
      { folder: "Belege", name: "beleg.pdf", type: "application/pdf" },
    ]);
    await page.waitForFunction(() =>
      document.querySelector("#sent .k2-files-hint[data-refused]")?.textContent?.startsWith("Dieses Feld nimmt Dateien"),
    );
  });
});

test("image: a second file it cannot take is said again", async () => {
  await withPage(async (page) => {
    const logo = field(page, "Logo");
    const picker = logo.locator('input[type="file"]');
    await picker.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await logo.getByRole("alert").waitFor();
    await logo.getByRole("alert").evaluate((alert) => alert.setAttribute("data-first", ""));
    await picker.setInputFiles({ name: "liste.txt", mimeType: "text/plain", buffer: Buffer.from("y") });
    // a new alert: assistive technology hears an alert when it enters the page, not when it stays
    await logo.locator('[role="alert"]:not([data-first])').waitFor();
    expect(await logo.getByRole("alert").count()).toBe(1);
  });
});

test("files: the field is where files are dropped; it shows while files are over it", async () => {
  await withPage(async (page) => {
    const zone = field(page, "Dokument").locator(".k2-files-drop");
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["# Titel"], "bericht.md", { type: "text/markdown" }));
      return data;
    });
    await zone.dispatchEvent("dragenter", { dataTransfer: transfer });
    await zone.dispatchEvent("dragover", { dataTransfer: transfer });
    await page.waitForFunction(() => document.querySelectorAll("#sent .k2-files-drop[data-dragging]").length === 1);
    await zone.dispatchEvent("drop", { dataTransfer: transfer });
    await field(page, "Dokument").locator(".k2-files-name").filter({ hasText: "bericht.md" }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll("#sent .k2-files-drop[data-dragging]").length === 0);
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
    const hue = field(page, "Ton").getByRole("slider", { name: "Farbton" });
    await hue.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#sent [aria-label="Farbton"]')].some((thumb) => thumb.getAttribute("aria-valuenow") === "1"),
    );
    expect(await hue.getAttribute("aria-valuetext")).toBe("1 Grad");
  });
});

for (const width of [1440, 1024, 390])
  test(`layout at ${width} px: edges, lines, type roles and grips hold`, async () => {
    await withPage(async (page) => {
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect(layout.problems).toEqual([]);
    }, width);
  });
