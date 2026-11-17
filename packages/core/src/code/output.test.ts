import { expect, test } from "bun:test";
import { sanitizeCodeOutput } from "./output";
import { secretEchoReplacements } from "./secret-echo";

test("console output redacts every HTTP echo spelling as a named structural secret, including encoded echoes", () => {
  const value = 'secret /+"value';
  const replacements = secretEchoReplacements([{ name: "TOKEN", value, sent: `Bearer ${value}` }]);
  for (const spelling of replacements.keys()) {
    const lines = sanitizeCodeOutput(
      { seq: 1, lines: [{ level: "error", text: `\x1b[31mbefore ${spelling}\x1b[0m\u202e after` }], droppedLines: 0, droppedBytes: 0 },
      replacements,
    );
    expect(lines).toEqual([
      {
        level: "error",
        parts: [
          { type: "text", text: "before " },
          { type: "secret", name: "TOKEN" },
          { type: "text", text: " after" },
        ],
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(value);
  }
});
test("text is split into lines and cleaned on both sides of redaction", () => {
  expect(
    sanitizeCodeOutput(
      { seq: 1, lines: [{ level: "log", text: "<b>\n\x9b31msecond\u2066\rthird" }], droppedLines: 0, droppedBytes: 0 },
      new Map(),
    ),
  ).toEqual([
    { level: "log", parts: [{ type: "text", text: "<b>" }] },
    { level: "log", parts: [{ type: "text", text: "second" }] },
    { level: "log", parts: [{ type: "text", text: "third" }] },
  ]);
});
