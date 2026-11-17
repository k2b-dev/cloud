import { expect, test } from "bun:test";
import { sanitizeCodeOutput } from "./output";
import { secretEchoReplacements } from "./secret-echo";

test("console output redacts every HTTP echo spelling as a named structural secret, including encoded echoes", () => {
  const value = 'secret /+"value';
  const replacements = secretEchoReplacements([{ name: "TOKEN", value, sent: `Bearer ${value}` }]);
  for (const spelling of replacements.keys()) {
    const lines = sanitizeCodeOutput(
      {
        seq: 1,
        entries: [
          { kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "error", text: `\x1b[31mbefore ${spelling}\x1b[0m\u202e after` },
        ],
        droppedLines: 0,
        droppedBytes: 0,
      },
      replacements,
    );
    expect(lines).toEqual([
      {
        kind: "log" as const,
        at: "2030-01-02T00:00:00.000Z",
        level: "error",
        text: [
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
      {
        seq: 1,
        entries: [{ kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: "<b>\n\x9b31msecond\u2066\rthird" }],
        droppedLines: 0,
        droppedBytes: 0,
      },
      new Map(),
    ),
  ).toEqual([
    { kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: [{ type: "text", text: "<b>" }] },
    { kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: [{ type: "text", text: "second" }] },
    { kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: [{ type: "text", text: "third" }] },
  ]);
});
