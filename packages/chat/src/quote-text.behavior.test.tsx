import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

// A quote is checked against a message's plain text on the server; a person selects it in the rendered message. Both
// must read the same words, or a real selection is refused. This renders each body with the message row itself.
const dom = isServer ? undefined : createDomTestHarness();
process.once("exit", () => dom?.cleanup());

if (isServer) test.skip("requires browser conditions", () => {});
else {
  const { decodeHTML } = await import("entities");
  const { messagePlainText } = await import("./system-messages");
  const ui = await import("@k2b/ui");
  const rendered = (body: string) => {
    const host = document.createElement("div");
    document.body.append(host);
    const stop = render(
      () =>
        createComponent(ui.LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(ui.MessageRow, { author: { name: "Lea Muster" }, text: body, time: "10:24" });
          },
        }),
      host,
    );
    const text = host.querySelector(".k2b-message-row__text")!;
    // Not selectable, so never part of a selection: the code bar and the "edited" mark.
    for (const chrome of text.querySelectorAll(".k2b-message-row__code-bar, .k2b-message-row__edited")) chrome.remove();
    const content = text.textContent ?? "";
    stop();
    host.remove();
    return content;
  };
  const words = (text: string) => text.replace(/\s+/gu, "");

  for (const body of [
    "Plain words and **bold** and *italic* text",
    "A [link](https://example.test/) and <https://example.test/auto>",
    "Tom &amp; Jerry, &copy; 2026, &hellip; and &#8364; and &euro;",
    "Run `a &amp; b` or `<b>raw</b>` now",
    "```sh\nbun install &amp;&amp; bun test\n```",
    "- first item\n- second item\n\n1. one\n2. two",
    "> quoted line\n\nafter it",
    "| A | B |\n| - | - |\n| 1 | 2 |",
    "Escaped \\*stars\\* and <b>tags as text</b>",
  ])
    test(`the plain text reads what the message shows: ${JSON.stringify(body)}`, () => {
      expect(words(messagePlainText(body, decodeHTML))).toBe(words(rendered(body)));
    });
}
