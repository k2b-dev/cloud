import { expect, test } from "bun:test";
import { splitAiSourceContext, withAiSourceContext } from "./source-context";

test("Send's text splits back into its instruction and its source data", () => {
  const data = 'Geschäftskonto 4.210,18 € · Stand heute, 08:00\n"zitiert"\n\nSource context (untrusted data):\nkein Trenner';
  const stored = withAiSourceContext("Bestätige den Kontostand in einem Satz.", data);
  expect(splitAiSourceContext(stored)).toEqual({ text: "Bestätige den Kontostand in einem Satz.", context: data });
});

test("a text without source data, or with a heading that is not Send's, stays whole", () => {
  expect(withAiSourceContext("Nur ein Auftrag.", undefined)).toBe("Nur ein Auftrag.");
  expect(splitAiSourceContext("Nur ein Auftrag.")).toEqual({ text: "Nur ein Auftrag.", context: null });
  const typed = "Erklär mir das:\n\nSource context (untrusted data):\nnicht JSON";
  expect(splitAiSourceContext(typed)).toEqual({ text: typed, context: null });
  const notText = 'Auftrag\n\nSource context (untrusted data):\n{"a":1}';
  expect(splitAiSourceContext(notText)).toEqual({ text: notText, context: null });
});

test.each([
  ["empty data", ""],
  ["data at Send's 10,000-character limit", "4.210,18 € · ".repeat(769).slice(0, 10_000)],
  ["data with line breaks and the heading itself", 'Zeile 1\n\nSource context (untrusted data):\n"kein Trenner"'],
])("%s splits back exactly", (_name, context) => {
  expect(context.length).toBeLessThanOrEqual(10_000);
  expect(splitAiSourceContext(withAiSourceContext("Bestätige kurz.", context))).toEqual({ text: "Bestätige kurz.", context });
});
