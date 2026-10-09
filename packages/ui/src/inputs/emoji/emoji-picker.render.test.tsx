import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-emoji-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { EmojiPicker, LocaleProvider } = await import("../../index");

const render = (locale: "en" | "de", props: Partial<Parameters<typeof EmojiPicker>[0]> = {}) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(EmojiPicker, { onPick: () => undefined, ...props });
      },
    }),
  );

describe("EmojiPicker on the server", () => {
  test("renders the search, the groups and the loading state of fixed size in English and German", () => {
    const english = render("en", { onSkinToneChange: () => undefined });
    expect(english).toContain('role="combobox"');
    expect(english).toContain('placeholder="Search emoji"');
    expect(english).toContain('aria-label="Skin tone"');
    expect(english).toContain('aria-label="Smileys &amp; emotion"');
    expect(english).toContain('aria-label="Flags"');
    expect(english).toContain('class="k2b-emoji-picker__state" role="status"');
    // The name line is there before anything is active, so nothing below the grid moves later.
    expect(english).toContain('class="k2b-emoji-picker__preview" aria-hidden="true"');

    const german = render("de");
    expect(german).toContain('placeholder="Emoji suchen"');
    expect(german).toContain('aria-label="Menschen &amp; Körper"');
    // Without a place to store it, there is no skin-tone choice.
    expect(german).not.toContain("Hautfarbe");
  });

  test("offers recently used emoji as the first group", () => {
    const html = render("en", { recent: ["🎉"] });
    expect(html.indexOf('aria-label="Recently used"')).toBeLessThan(html.indexOf('aria-label="Smileys &amp; emotion"'));
  });

  test("renders a closed popover without a picker inside", () => {
    const html = renderToString(() =>
      createComponent(EmojiPicker.Popover, { anchor: undefined, onPick: () => undefined, onClose: () => undefined }),
    );
    expect(html).toContain('popover="auto"');
    expect(html).not.toContain("k2b-emoji-picker__search");
  });
});
