import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-activity-words-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Chat, chatActivityWordAt } = await import("../index");
const FIRST = "Denkt nach";
const WORDS = ["Grübelt", "Tüftelt", "Spitzt den Bleistift"];

test("the word follows the phase time: the first word for 3 s, then one word per 2.4 s, round after round", () => {
  // Frozen times, as Feinschliff v3 section 1 names them.
  expect([0, 2_900, 2_999, 3_000, 5_399, 5_400, 7_800, 10_200].map((ms) => chatActivityWordAt(FIRST, WORDS, ms))).toEqual([
    FIRST,
    FIRST,
    FIRST,
    "Grübelt",
    "Grübelt",
    "Tüftelt",
    "Spitzt den Bleistift",
    "Grübelt",
  ]);
  expect(chatActivityWordAt(FIRST, [], 60_000)).toBe(FIRST);
  expect(chatActivityWordAt(FIRST, WORDS, Number.NaN)).toBe(FIRST);
});

test("the server renders exactly one word, the one for its time, silent beside one announcement", () => {
  for (const [elapsedMs, word] of [
    [2_999, FIRST],
    [3_000, "Grübelt"],
    [5_400, "Tüftelt"],
  ] as const) {
    const html = renderToString(() =>
      createComponent(Chat.Activity, {
        icon: "ti ti-sparkles",
        tone: "ai",
        busy: true,
        get label() {
          return createComponent(Chat.Activity.Words, { first: FIRST, words: WORDS, elapsedMs, announce: "Gustav denkt nach" });
        },
        trailing: "4 s",
      }),
    );
    const slot = html.match(/<span class="k2b-chat-activity__words" aria-hidden="true">([\s\S]*?)<\/span><\/span>/)?.[1] ?? "";
    expect((slot.match(/k2b-chat-activity__word"/g) ?? []).length, String(elapsedMs)).toBe(1);
    expect(slot.match(/data-phase="still">([^<]*)/)?.[1], String(elapsedMs)).toBe(word);
    expect(html.match(/role="status"/g)?.length).toBe(1);
    expect(html).toContain(">Gustav denkt nach<");
  }
});
