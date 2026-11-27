import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// A German screen shows no English word of the library: the words of FilterBar, Setting, the overlays and the shared
// UI follow the language the screen renders in. Every recipe renders here as Fibel shows it (its `locale`, else
// German), and its text, names and hints are scanned for words that only the English catalogs have.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-locale-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { LocaleProvider } = await import("../intl/locale");
const { resolveUiMessages } = await import("../intl/messages");
const { resolveFilterMessages } = await import("./filter-messages");
const { resolveOverlayMessages } = await import("./overlay-messages");
const { resolveSettingMessages } = await import("./setting-messages");

/** Every text a catalog can say in one language: its words, and its templates filled with a placeholder. */
const sayings = (messages: object): string[] => {
  const filled = new Proxy({}, { get: () => "X" });
  return Object.values(messages).flatMap((value) => {
    if (typeof value === "string") return [value];
    if (typeof value === "function") {
      try {
        const said = value(filled);
        return typeof said === "string" ? [said] : [];
      } catch {
        return [];
      }
    }
    return [];
  });
};
const words = (texts: readonly string[]) => new Set(texts.flatMap((text) => text.toLowerCase().match(/\p{L}+/gu) ?? []));
// words both languages write the same way, so they prove nothing
const shared = new Set(["was", "man", "die", "war", "hat", "bin", "so", "an", "in", "um", "am", "im", "es", "er", "ob", "zu", "x"]);
const catalogs = [resolveUiMessages, resolveFilterMessages, resolveOverlayMessages, resolveSettingMessages];
const german = words(catalogs.flatMap((resolveIn) => sayings(resolveIn("de"))));
const englishOnly = [...words(catalogs.flatMap((resolveIn) => sayings(resolveIn("en"))))].filter(
  (word) => !german.has(word) && !shared.has(word) && word.length > 1,
);

/** What a person reads or hears: the text between tags and the names, hints and placeholders of elements. */
const readable = (markup: string) =>
  [
    ...markup
      .replace(/<!--[^>]*-->/g, "")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, "")
      .matchAll(/>([^<]+)</g),
    ...markup.matchAll(/(?:aria-label|title|placeholder|aria-valuetext)="([^"]*)"/g),
  ].map((match) => match[1]!);

const recipesDir = resolve(import.meta.dir, "../../skills/k2b-ui/recipes");
const recipes = readdirSync(recipesDir).filter((name) => name.endsWith(".tsx"));

test("the English catalogs have words of their own to look for", () => {
  // a guard of the guard: the scan looks for these at least
  for (const word of ["reset", "changed", "or"]) expect(englishOnly).toContain(word);
});

for (const name of recipes)
  test(`${name} in German shows no English word of the library`, async () => {
    const recipe = (await import(resolve(recipesDir, name))) as {
      default: (props: Record<string, never>) => JSX.Element;
      states?: Record<string, (() => JSX.Element) | { render: () => JSX.Element }>;
      locale?: string;
    };
    if (recipe.locale !== undefined && recipe.locale !== "de") return;
    const screens = [
      () => createComponent(recipe.default, {}),
      ...Object.values(recipe.states ?? {}).map((state) => (typeof state === "function" ? state : state.render)),
    ];
    for (const screen of screens) {
      const markup = renderToString(() =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return screen();
          },
        }),
      );
      // each English word with the text it stands in, so a finding names its place
      // initials and types ("TO", "PDF") are no words of a language
      const found = readable(markup)
        .filter((text) => !/^\s*[A-ZÄÖÜ]{1,4}\s*$/.test(text))
        .flatMap((text) =>
          [...words([text])].filter((word) => englishOnly.includes(word)).map((word) => `${word}: ${text.trim().slice(0, 80)}`),
        );
      expect(found).toEqual([]);
    }
  });
