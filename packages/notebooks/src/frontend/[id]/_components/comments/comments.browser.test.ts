import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../../../../ui/test/browser";
import { NOW, startCommentsServer } from "./comments.browser-server";

// Where comments stand is layout: the margin's width rule, the column that never moves, the marks the server
// preview draws before the editor exists. Only a real engine computes them.
let browser: Browser;
let server: Awaited<ReturnType<typeof startCommentsServer>>;
beforeAll(async () => {
  server = await startCommentsServer();
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  server?.stop();
});

/**
 * The fake clock runs the app's timers; a reply from the harness can still start a card's short move or tint while the
 * page settles, which `settled` reports. Such a move ends by itself, so settling starts again a few times.
 */
const settle = async (page: Page) => {
  await page.clock.runFor(400);
  for (let attempt = 0; ; attempt++) {
    try {
      return await settled(page);
    } catch (error) {
      if (attempt >= 4 || !String(error).includes("kept animating")) throw error;
    }
  }
};
const open = async (query: string, width = 1440, height = 900, waitForEditor = true) => {
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  await page.clock.install({ time: NOW });
  await page.goto(`${server.url}/?${query}`, { waitUntil: waitForEditor ? "load" : "commit" });
  if (waitForEditor) {
    await page.waitForSelector(".cm-editor .cm-content");
    await settle(page);
  }
  return page;
};
const close = (page: Page) => page.context().close();
/** Boxes of the marked passages, by comment, and of the first letter of the note. */
const marks = (page: Page, scope: string) =>
  page.evaluate((scope) => {
    // A passage overlapping another is drawn in several pieces; its start is the leftmost piece on its first line.
    const boxes: Record<string, number[]> = {};
    for (const mark of document.querySelectorAll<HTMLElement>(`${scope} [data-annotation]`)) {
      const box = mark.getClientRects()[0];
      if (!box) continue;
      const id = mark.dataset.annotation!;
      const [left, top] = boxes[id] ?? [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
      if (box.top < top! - 2 || (Math.abs(box.top - top!) <= 2 && box.left < left!))
        boxes[id] = [Math.round(box.left), Math.round(box.top)];
    }
    return boxes;
  }, scope);
const select = async (page: Page, needle: string) => {
  const box = await page.evaluate((needle) => {
    for (const node of document.querySelectorAll(".cm-content .cm-line")) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const index = text.textContent!.indexOf(needle);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(text, index);
        range.setEnd(text, index + needle.length);
        const rect = range.getBoundingClientRect();
        return { left: rect.left + 1, right: rect.right - 1, y: rect.top + rect.height / 2 };
      }
    }
    throw new Error(`Not in the note: ${needle}`);
  }, needle);
  await page.mouse.move(box.left, box.y);
  await page.mouse.down();
  await page.mouse.move(box.right, box.y, { steps: 6 });
  await page.mouse.up();
  await settle(page);
};
const layout = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.querySelector(".notebook-comments-host")!).getPropertyValue("--notebook-comments-layout").trim(),
  );
const columnLeft = (page: Page) => page.evaluate(() => Math.round(document.querySelector(".cm-content")!.getBoundingClientRect().left));

describe("inline comments", () => {
  test("the server preview marks every passage where the editor marks it, so nothing moves when it mounts", async () => {
    for (const width of [2000, 1440]) {
      const page = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
      try {
        await page.clock.install({ time: NOW });
        // The editor's script waits until the preview is measured.
        await page.route("**/editor.js", async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          await route.continue();
        });
        await page.goto(`${server.url}/?s=base`, { waitUntil: "commit" });
        await page.waitForSelector("#notebook-note-preview [data-annotation]");
        // settled: the server preview's first frame, before the editor mounts, is the subject.
        const before = await marks(page, "#notebook-note-preview");
        expect(Object.keys(before).length).toBe(5);
        await page.waitForSelector(".cm-editor [data-annotation]");
        await settle(page);
        const after = await marks(page, ".cm-editor");
        for (const [id, [left, top]] of Object.entries(before)) {
          expect(Math.abs(after[id]![0]! - left!), `${width} ${id} left`).toBeLessThanOrEqual(1);
          expect(Math.abs(after[id]![1]! - top!), `${width} ${id} top`).toBeLessThanOrEqual(1);
        }
      } finally {
        await close(page);
      }
    }
  }, 60_000);

  test("the width alone decides the layout, never the comments: the column stands where it stands without them", async () => {
    for (const [width, expected] of [
      [2000, "wide"],
      [1440, "shift"],
      [1100, "compact"],
      [390, "phone"],
    ] as const) {
      const empty = await open("s=empty", width);
      const full = await open("s=base", width);
      try {
        expect(await layout(full), `${width}`).toBe(expected);
        expect(await layout(empty), `${width}`).toBe(expected);
        expect(await columnLeft(full), `${width}`).toBe(await columnLeft(empty));
        if (expected === "wide" || expected === "shift") {
          const margin = await full.evaluate(() => {
            const content = document.querySelector(".cm-content")!.getBoundingClientRect();
            const aside = document.querySelector(".notebook-comments")!.getBoundingClientRect();
            return { gap: aside.left - content.right, width: aside.width, fits: aside.right <= document.documentElement.clientWidth };
          });
          expect(margin).toEqual({ gap: 40, width: 288, fits: true });
        }
        if (expected === "compact") expect(await full.locator(".notebook-comments-dot").count()).toBeGreaterThan(0);
      } finally {
        await close(empty);
        await close(full);
      }
    }
  }, 120_000);

  test("opening a comment, its passage and the composer never move the text", async () => {
    const page = await open("s=base");
    try {
      const text = () =>
        page.evaluate(() =>
          [...document.querySelectorAll(".cm-line")].slice(0, 12).map((line) => Math.round(line.getBoundingClientRect().top)),
        );
      const before = await text();
      await page.locator(".cm-editor .cm-annotation").first().click();
      await settle(page);
      expect(await page.locator("[data-annotation-card][data-active]").count()).toBe(1);
      expect(await text()).toEqual(before);
      await page.keyboard.press("Escape");
      await settle(page);
      await select(page, "regelmäßiges Training");
      await page.locator(".k2b-selection-toolbar").getByRole("button", { name: "Kommentieren" }).click();
      await settle(page);
      expect(await text()).toEqual(before);
    } finally {
      await close(page);
    }
  }, 60_000);

  test("a comment is written at its passage, saved once, and kept with a retry when saving fails", async () => {
    const page = await open("s=base");
    try {
      await select(page, "regelmäßiges Training");
      const toolbar = page.locator(".k2b-selection-toolbar");
      expect(await toolbar.evaluate((element) => element.matches(":popover-open"))).toBe(true);
      await page.locator(".k2b-selection-toolbar").getByRole("button", { name: "Kommentieren" }).click();
      await settle(page);
      // The passage is pre-marked in the writer's color while the comment is written.
      expect(await page.locator(".cm-annotation-draft").textContent()).toBe("regelmäßiges Training");
      await page.keyboard.type("fail once");
      await page.keyboard.press("Control+Enter");
      await settle(page);
      await settle(page);
      expect(await page.locator("[data-composer] [role=alert]").textContent()).toContain("Nicht gespeichert");
      // The text stays, and trying again sends it with the same key, so a save that did arrive is not made twice.
      await page.getByRole("button", { name: "Erneut versuchen" }).click();
      await settle(page);
      await settle(page);
      const posted = server.calls.filter((call) => call.method === "POST" && call.path === "/");
      expect(posted).toHaveLength(2);
      expect((posted[1]!.body as { idempotencyKey: string }).idempotencyKey).toBe(
        (posted[0]!.body as { idempotencyKey: string }).idempotencyKey,
      );
      expect(posted[1]!.body).toMatchObject({
        quote: "regelmäßiges Training",
        suffix: ", die Teilnahme an Regatten und ",
        body: "fail once",
      });
      expect(await page.locator("[data-annotation-card][data-active]").textContent()).toContain("fail once");
      expect(await page.locator(".notebook-comments__head").textContent()).toContain("6 offen");
    } finally {
      await close(page);
    }
  }, 60_000);

  test("changed text after a failed save is a new save", async () => {
    const page = await open("s=base");
    try {
      await select(page, "regelmäßiges Training");
      await page.locator(".k2b-selection-toolbar").getByRole("button", { name: "Kommentieren" }).click();
      await settle(page);
      await page.keyboard.type("fail");
      await page.keyboard.press("Control+Enter");
      await settle(page);
      await settle(page);
      await page.getByRole("textbox", { name: "Kommentar" }).fill("Auch Wanderfahrten nennen?");
      await settle(page);
      await page.locator("[data-composer]").getByRole("button", { name: "Kommentieren" }).click();
      await settle(page);
      await settle(page);
      const posted = server.calls.filter((call) => call.method === "POST" && call.path === "/");
      expect(posted).toHaveLength(2);
      expect((posted[1]!.body as { idempotencyKey: string }).idempotencyKey).not.toBe(
        (posted[0]!.body as { idempotencyKey: string }).idempotencyKey,
      );
      expect(await page.locator("[data-annotation-card][data-active]").textContent()).toContain("Auch Wanderfahrten nennen?");
      expect(await page.locator(".notebook-comments__head").textContent()).toContain("6 offen");
    } finally {
      await close(page);
    }
  }, 60_000);

  test("⌘⌥M comments the word at the caret, Escape cancels", async () => {
    const page = await open("s=base");
    try {
      // The caret inside "eingetragen", without a selection.
      const word = await page.evaluate(() => {
        for (const text of document.querySelectorAll(".cm-line")) {
          const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const index = node.textContent!.indexOf("eingetragen");
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(node, index + 4);
            range.setEnd(node, index + 5);
            const box = range.getBoundingClientRect();
            return { x: box.left, y: box.top + box.height / 2 };
          }
        }
        throw new Error("no word");
      });
      await page.mouse.click(word.x, word.y);
      await settle(page);
      await page.keyboard.press("Control+Alt+m");
      await settle(page);
      expect(await page.locator(".cm-annotation-draft").textContent()).toBe("eingetragen");
      await page.keyboard.press("Escape");
      await settle(page);
      expect(await page.locator(".cm-annotation-draft").count()).toBe(0);
      expect(await page.locator("[data-composer]").count()).toBe(0);
    } finally {
      await close(page);
    }
  }, 60_000);

  test("people who may only read see passages and comments but no selection toolbar and no actions", async () => {
    const page = await open("s=base&readonly&reader");
    try {
      await page.locator(".cm-editor .cm-annotation").first().click();
      await settle(page);
      const card = page.locator("[data-annotation-card][data-active]");
      expect(await card.textContent()).toContain("Im Kinderkurs");
      expect(await card.getByRole("button").count()).toBe(0);
      expect(await card.getByRole("textbox").count()).toBe(0);
      expect(await page.locator(".notebook-comments__hint").count()).toBe(0);
      await select(page, "regelmäßiges Training");
      expect(await page.locator(".k2b-selection-toolbar").evaluate((element) => element.matches(":popover-open"))).toBe(false);
    } finally {
      await close(page);
    }
  }, 60_000);

  test("pointing at a passage highlights its comment, and a resolved comment leaves with an undo", async () => {
    const page = await open("s=base");
    try {
      await page.locator(".cm-editor .cm-annotation", { hasText: "innerhalb" }).first().hover();
      await settle(page);
      expect(await page.locator("[data-annotation-card][data-hover]").textContent()).toContain("Sommerferien");
      const card = page.locator("[data-annotation-card]", { hasText: "Sommerferien" });
      await card.hover();
      await card.getByRole("button", { name: "Als erledigt markieren" }).click();
      await settle(page);
      await settle(page);
      expect(await page.locator("[data-annotation-card]", { hasText: "Sommerferien" }).count()).toBe(0);
      expect(await page.locator(".notebook-comments__head").textContent()).toContain("1 erledigt");
      await page.getByRole("button", { name: "Rückgängig" }).click();
      await settle(page);
      await settle(page);
      expect(await page.locator("[data-annotation-card]", { hasText: "Sommerferien" }).count()).toBe(1);
    } finally {
      await close(page);
    }
  }, 60_000);

  test("a failed load says so in the margin's head with a way to try again, and the text stays editable", async () => {
    const page = await open("s=error");
    try {
      await settle(page);
      expect(await page.locator(".notebook-comments__head").textContent()).toContain("Kommentare konnten nicht geladen werden.");
      expect(await page.getByRole("button", { name: "Erneut versuchen" }).count()).toBe(1);
      await page.locator(".cm-line", { hasText: "Vereinsregister" }).click();
      await page.keyboard.type("!");
      expect(await page.locator(".cm-line", { hasText: "Vereinsregister" }).textContent()).toContain("!");
    } finally {
      await close(page);
    }
  }, 60_000);

  test("on a phone, a tapped passage opens its comment in a sheet and the toolbar lists every open one", async () => {
    const page = await open("s=base", 390, 844);
    try {
      await page.locator(".cm-editor .cm-annotation").first().click();
      await settle(page);
      await settle(page);
      const sheet = page.locator(".k2b-bottom-sheet-frame");
      expect(await sheet.textContent()).toContain("Im Kinderkurs");
      await page.getByRole("button", { name: "Schließen" }).first().click();
      await settle(page);
      await settle(page);
      await page.locator(".notebook-comments-button").click();
      await settle(page);
      await settle(page);
      expect(await page.locator(".k2b-bottom-sheet-frame [data-annotation-card]").count()).toBe(5);
    } finally {
      await close(page);
    }
  }, 60_000);
  test("a reply being typed survives a live reload of the comments", async () => {
    const page = await open("s=base");
    try {
      await page.locator(".cm-editor .cm-annotation").first().click();
      await settle(page);
      const reply = page.locator("[data-annotation-card][data-active]").getByRole("textbox", { name: "Antworten" });
      await reply.click();
      await page.keyboard.type("Halbfertige Antwort");
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("notebooks.workspace.event", {
            detail: {
              cursor: null,
              event: { v: 1, type: "note.comments.changed", notebookId: "book01", noteId: "note01" },
              cover: () => {},
            },
          }),
        ),
      );
      await settle(page);
      await settle(page);
      expect(await reply.inputValue()).toBe("Halbfertige Antwort");
      expect(await reply.evaluate((element) => element === document.activeElement)).toBe(true);
    } finally {
      await close(page);
    }
  }, 60_000);

  test("accepting a suggestion in Read shows the new text, and Escape from the composer returns to the passage", async () => {
    const page = await open("s=base&readonly");
    try {
      await page.locator(".cm-editor .cm-annotation").first().click();
      await settle(page);
      await page.getByRole("button", { name: "Übernehmen" }).click();
      await settle(page);
      await settle(page);
      expect(await page.locator(".cm-content").textContent()).toContain("das achte Lebensjahr vollendet hat");
      expect(await page.locator(".cm-content").textContent()).not.toContain("das zehnte Lebensjahr");
    } finally {
      await close(page);
    }
    const editor = await open("s=base");
    try {
      await select(editor, "regelmäßiges Training");
      await editor.locator(".k2b-selection-toolbar").getByRole("button", { name: "Kommentieren" }).click();
      await settle(editor);
      await editor.keyboard.press("Escape");
      await settle(editor);
      expect(await editor.locator("[data-composer]").count()).toBe(0);
      expect(await editor.evaluate(() => !!document.activeElement?.closest(".cm-content"))).toBe(true);
    } finally {
      await close(editor);
    }
  }, 60_000);

  test("with dots beside the lines, each comment's popover stands below its own passage", async () => {
    const page = await open("s=base&panel", 1440);
    try {
      const dots = page.locator(".notebook-comments-dot");
      for (const index of [0, (await dots.count()) - 1]) {
        await dots.nth(index).click();
        await settle(page);
        const gap = await page.evaluate(() => {
          const id = document.querySelector<HTMLElement>(".notebook-comments-popover [data-annotation-card]")!.dataset.annotationCard!;
          const marks = [...document.querySelectorAll(`.cm-editor [data-annotation="${id}"]`)].flatMap((mark) => [
            ...mark.getClientRects(),
          ]);
          const bottom = Math.max(...marks.map((rect) => rect.bottom));
          return document.querySelector(".notebook-comments-popover")!.getBoundingClientRect().top - bottom;
        });
        expect(gap, `dot ${index}`).toBeGreaterThan(0);
        expect(gap, `dot ${index}`).toBeLessThan(16);
      }
    } finally {
      await close(page);
    }
  }, 60_000);

  test("on a phone, a failed load says so in the list with a way to try again", async () => {
    const page = await open("s=error", 390, 844);
    try {
      await page.locator(".notebook-comments-button").click();
      await settle(page);
      await settle(page);
      const sheet = page.locator(".k2b-bottom-sheet-frame");
      expect(await sheet.textContent()).toContain("Kommentare konnten nicht geladen werden.");
      expect(await sheet.getByRole("button", { name: "Erneut versuchen" }).count()).toBe(1);
    } finally {
      await close(page);
    }
  }, 60_000);

  test("an agent's suggestion in a reply on my thread is accepted with one click and changes the text", async () => {
    const page = await open("s=review&readonly");
    try {
      const card = page.locator("[data-annotation-card]", { hasText: "Mustersatzung" });
      await card.click();
      await settle(page);
      expect(await card.textContent()).toContain("Review Agent");
      expect(await card.textContent()).toContain("über Assistant");
      expect(await card.locator(".notebook-comment__suggestion").textContent()).toContain("mit einer Frist von drei Monaten");
      await card.getByRole("button", { name: "Übernehmen" }).click();
      await settle(page);
      await settle(page);
      expect(await page.locator(".cm-content").textContent()).toContain("zum Ende eines Quartals mit einer Frist von drei Monaten möglich");
      expect(await page.locator(".notebook-comments__head").textContent()).toContain("1 erledigt");
    } finally {
      await close(page);
    }
  }, 60_000);

  test("rejecting an agent's suggestion keeps the text, marks it rejected and can be undone", async () => {
    const page = await open("s=review");
    try {
      const card = page.locator("[data-annotation-card]", { hasText: "Mustersatzung" });
      await card.click();
      await settle(page);
      await card.getByRole("button", { name: "Ablehnen" }).click();
      await settle(page);
      await settle(page);
      expect(await card.locator(".notebook-comment__suggestion").textContent()).toContain("Abgelehnt");
      expect(await card.getByRole("button", { name: "Übernehmen" }).count()).toBe(0);
      expect(await page.locator(".cm-content").textContent()).toContain("mit einer Frist von sechs Wochen");
      await page.getByRole("button", { name: "Rückgängig" }).click();
      await settle(page);
      await settle(page);
      expect(await card.getByRole("button", { name: "Übernehmen" }).count()).toBe(1);
    } finally {
      await close(page);
    }
  }, 60_000);
});
