import { expect, test } from "bun:test";
import { compileOutputRedaction, type OutputRedactionPending, redactOutput } from "./output-redaction";
import { secretEchoReplacements } from "./secret-echo";

const line = (text: string) => ({ kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log" as const, text });
const value = 'abcdefgh /+"value';
const replacements = secretEchoReplacements([{ name: "TOKEN", value, sent: `Bearer ${value}` }]);
for (const spelling of replacements.keys()) {
  for (const boundary of ["line", "batch"] as const) {
    test(`harden output redaction at ${boundary} boundaries for ${Buffer.from(spelling).toString("hex")}`, () => {
      const redactor = compileOutputRedaction(replacements);
      const middle = Math.floor(spelling.length / 2);
      const left = spelling.slice(0, middle),
        right = spelling.slice(middle);
      const first = redactOutput([line(left)], redactor);
      expect(first.entries.flatMap((line) => line.text)).toEqual([]);
      expect(first.pending!.text.length).toBeLessThan(redactor.longest);
      const result =
        boundary === "batch" ? redactOutput([line(right)], redactor, first.pending) : redactOutput([line(left), line(right)], redactor);
      const finished = redactOutput([], redactor, result.pending, true);
      const parts = [...result.entries, ...finished.entries].flatMap((line) => line.text);
      expect(parts.filter((part) => part.type === "secret")).toEqual([{ type: "secret", name: "TOKEN" }]);
      expect(parts.filter((part) => part.type === "text")).toEqual([]);
    });
  }
}
test("harden unfinished output fragments at finalization and keep the pending suffix bounded", () => {
  const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
  let pending: OutputRedactionPending = null;
  for (const text of ["ab", "cd", "ef"]) {
    const result = redactOutput([line(text)], redactor, pending);
    expect(result.entries.flatMap((line) => line.text)).toEqual([]);
    expect(result.pending!.text.length).toBeLessThan(redactor.longest);
    pending = result.pending;
  }
  expect(redactOutput([], redactor, pending, true).entries).toEqual([{ kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: [{ type: "secret", name: "TOKEN" }] }]);
});
test("harden longest-match handling while releasing resolved ordinary text", () => {
  const redactor = compileOutputRedaction(
    new Map([
      ["abc", "[secret:SHORT]"],
      ["abcdef", "[secret:LONG]"],
    ]),
  );
  const first = redactOutput([line("prefix abc")], redactor);
  expect(first.entries).toEqual([{ kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: [{ type: "text", text: "prefix " }] }]);
  expect(redactOutput([line("def tail")], redactor, first.pending).entries.flatMap((line) => line.text)).toEqual([
    { type: "secret", name: "LONG" },
    { type: "text", text: " tail" },
  ]);
  const mismatch = redactOutput([line("ab"), line("x")], redactor);
  expect(mismatch.pending).toBeNull();
  expect(mismatch.entries.map((line) => line.text)).toEqual([[{ type: "text", text: "ab" }], [{ type: "text", text: "x" }]]);
});

for (const boundary of ["line", "batch"] as const) {
  test(`harden Unicode output continuity at ${boundary} boundaries`, () => {
    const redactor = compileOutputRedaction(new Map([["ab😀cd", "[secret:TOKEN]"]]));
    const value = "ab😀cd";
    const left = line(value.slice(0, 3));
    const right = line(value.slice(3));
    const first = redactOutput([left], redactor);
    expect(first.entries.flatMap((line) => line.text)).toEqual([]);
    const result = boundary === "batch" ? redactOutput([right], redactor, first.pending) : redactOutput([left, right], redactor);
    expect(result.entries.flatMap((line) => line.text)).toEqual([{ type: "secret", name: "TOKEN" }]);
    expect(result.pending).toBeNull();
  });
}

test("deferred structured entries retain their original kind, level and timestamp", () => {
  const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
  const first = { ...line("abcd"), level: "error" as const };
  const second = { ...line("efgh tail"), at: "2030-01-02T00:00:01.000Z", level: "warn" as const };
  const pending = redactOutput([first], redactor).pending;
  const result = redactOutput([second], redactor, pending);
  expect(result.entries).toEqual([
    { kind: first.kind, level: first.level, at: first.at, text: [{ type: "secret", name: "TOKEN" }] },
    { kind: second.kind, level: second.level, at: second.at, text: [{ type: "text", text: " tail" }] },
  ]);
  expect(redactOutput([], redactor, pending, true).entries).toEqual([
    { kind: first.kind, level: first.level, at: first.at, text: [{ type: "secret", name: "TOKEN" }] },
  ]);
});
