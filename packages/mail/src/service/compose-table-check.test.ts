import { expect, test } from "bun:test";
import { localizedComposeRenderMessage } from "./compose-render-errors";
import { type ComposeRenderContext, renderComposeContent } from "./compose-renderer";

const context: ComposeRenderContext = {
  actor: { display_name: "Ada", email: "ada@example.test" },
  mailbox: { name: "Test", description: "" },
  sender: { display_name: "Ada", email: "ada@example.test", reply_to: "" },
  message: { subject: "Table", to: ["reader@example.test"], cc: [] },
};
const extra = "| A | B |\n| --- | --- |\n| first | second | KEEP ME |";
const render = (body: string, options: Partial<Parameters<typeof renderComposeContent>[0]> = {}) =>
  renderComposeContent({ body, format: "markdown", customCss: "", context, renderLiquid: false, ...options });

for (const body of [extra, extra.replaceAll("\n", "\r\n"), `${extra}\n\nKEEP ME`, extra.replace("KEEP ME |", "KEEP ME")]) {
  test(`preview and send renderer refuses extra table cells: ${JSON.stringify(body)}`, () => {
    const result = render(body);
    expect(result).toMatchObject({ ok: false, error: { composeRender: { reason: "tableNeedsReview" } } });
    if (result.ok) throw new Error("The extra cell was silently omitted");
    expect(localizedComposeRenderMessage(result.error, "de")).toStartWith("Tabelle prüfen:");
    expect(localizedComposeRenderMessage(result.error, "en")).toStartWith("Check table:");
  });
}

test("checks selected and expanded legacy signatures too", () => {
  for (const result of [render("Hello", { signature: extra }), render(`\u2063${extra}\u2064`, { renderLiquid: true })]) {
    expect(result).toMatchObject({ ok: false, error: { composeRender: { reason: "tableNeedsReview" } } });
  }
});

test("adding the missing column keeps the previously omitted content", () => {
  const result = render("| A | B | C |\n| --- | --- | --- |\n| first | second | KEEP ME |");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data.text).toContain("KEEP ME");
  expect(result.data.html).toContain("KEEP ME");
});

test("short rows and escaped pipes remain valid", () => {
  const result = render("| A | B |\n| --- | --- |\n| first |\n| a\\|b | second |");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data.text).toContain("a|b");
});

test("table-shaped plain text and fenced code remain visible", () => {
  for (const result of [render(extra, { format: "plain" }), render(`\`\`\`text\n${extra}\n\`\`\``)]) {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.text).toContain("KEEP ME");
  }
});
