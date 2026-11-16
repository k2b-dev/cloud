import { expect, test } from "bun:test";
import "../../../../ui/test/solid-ssr-preload";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AiTurnBlock } from "../protocol";
import { layoutAiTurn } from "./turn-layout";

const { createAiToolDisclosureState } = await import("./tool-disclosure");
const { AiTurnView } = await import("./turn-view");

const tool = (name: string, result: unknown = {}): AiTurnBlock => ({
  id: name,
  kind: "tool",
  callId: name,
  name,
  args: { codeId: "fictional-automation" },
  status: "completed",
  result,
});

const render = (blocks: AiTurnBlock[], locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AiTurnView, {
          segment: () => ({
            id: "fictional-turn:0",
            turnId: "fictional-turn",
            phase: "completed",
            layout: layoutAiTurn(blocks, { phase: "completed" }),
            earlier: false,
            duration: () => ({ workedMs: 12_000, waitingMs: null }),
          }),
          disclosureState: createAiToolDisclosureState(),
        });
      },
    }),
  );

const sentence = (html: string) => {
  const match = /<span class="ai-turn-work__sentence[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  expect(match).not.toBeNull();
  return match?.[1]?.replace(/<!--[\s\S]*?-->/g, "");
};

test("the rendered summary uses evidence, never result wording or the forbidden catalog phrases", () => {
  const testResult = {
    ok: false,
    words: {
      examples: {
        passed: 0,
        total: 1,
        summary: "Passt OK Gut Fertig ausprobiert getestet Code Gegengerechnet",
        explanation: "Erfolgreich heißt: Die Automation hat getan, was Gustav für den Fall erwartet hat.",
        items: [{ name: "Fiktiver Fall", state: "failed", status: "Abweichung", sentence: "Ergebnis", differences: [] }],
      },
    },
  };
  const scenarios: AiTurnBlock[][] = [
    [tool("code_pull")],
    [tool("code_init"), tool("code_write")],
    [tool("code_test", testResult)],
    [tool("code_check", { words: { mayDo: [] } })],
    [tool("code_submit")],
    [tool("code_run", { status: "completed" })],
    [tool("read_file"), tool("code_run", { status: "completed" })],
    [tool("write_file", { path: "/reports/fictional.csv", mediaType: "text/csv" })],
  ];
  for (const blocks of scenarios) {
    const text = sentence(render(blocks));
    expect(text).toBeTruthy();
    expect(text).not.toMatch(/\b(?:Passt|OK|Gut|Fertig|ausprobiert|getestet|Code|Gegengerechnet)\b/i);
    expect(text).not.toMatch(/Schritte|12 s|fehlgeschlagen/);
  }
  const html = render([tool("code_test", testResult)]);
  expect(sentence(html)).toBe("0 von 1 Beispielen erfolgreich");
  expect(html).toContain("1 fehlgeschlagen");
});
