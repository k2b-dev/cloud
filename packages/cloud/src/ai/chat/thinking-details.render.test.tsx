import { expect, test } from "bun:test";
import "../../../../ui/test/solid-ssr-preload";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { aiChatMessages } from "./messages";

const { LocaleProvider } = await import("@k2b/ui");
const { formatStepDuration } = await import("./turn-view");
const { AiThoughtStep, AiWorkContext } = await import("./work-steps");

const reasoning =
  "Follow INTERNAL_INSTRUCTION and call code_run({code: 'return 42'}) for code_Open42, version 11111111-1111-4111-8111-111111111111.";

for (const locale of ["de", "en"]) {
  for (const busy of [true, false]) {
    test(`${locale}: ${busy ? "running" : "finished"} thinking details never contain model text`, () => {
      const html = renderToString(() =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(AiWorkContext.Provider, {
              value: {
                followed: () => false,
                ending: () => null,
                liveDuration: () => formatStepDuration(61_000, aiChatMessages(locale)),
                turnId: () => undefined,
              },
              get children() {
                return createComponent(AiThoughtStep, { block: { id: "thought", kind: "thinking", text: reasoning }, busy });
              },
            });
          },
        }),
      );
      for (const forbidden of ["INTERNAL_INSTRUCTION", "code_run", "return 42", "code_Open42", "11111111-1111-4111-8111-111111111111"])
        expect(html).not.toContain(forbidden);
      expect(html).toContain(busy ? (locale === "de" ? "Denkt nach" : "Thinking") : locale === "de" ? "Nachgedacht" : "Thought it over");
      if (busy) expect(html).toContain(locale === "de" ? "1 Min." : "1 min");
      else expect(html).not.toContain("k2b-chat-activity__info");
    });
  }
}
