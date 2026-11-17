import { expect, test } from "bun:test";
import { compileOutputRedaction, type OutputRedactionPending, redactOutput } from "./output-redaction";
import { secretEchoReplacements } from "./secret-echo";

const line = (text: string) => ({ level: "log" as const, text });
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
      expect(first.lines.flatMap((line) => line.parts)).toEqual([]);
      expect(first.pending!.text.length).toBeLessThan(redactor.longest);
      const result =
        boundary === "batch" ? redactOutput([line(right)], redactor, first.pending) : redactOutput([line(left), line(right)], redactor);
      const finished = redactOutput([], redactor, result.pending, true);
      const parts = [...result.lines, ...finished.lines].flatMap((line) => line.parts);
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
    expect(result.lines.flatMap((line) => line.parts)).toEqual([]);
    expect(result.pending!.text.length).toBeLessThan(redactor.longest);
    pending = result.pending;
  }
  expect(redactOutput([], redactor, pending, true).lines).toEqual([{ level: "log", parts: [{ type: "secret", name: "TOKEN" }] }]);
});
test("harden longest-match handling while releasing resolved ordinary text", () => {
  const redactor = compileOutputRedaction(
    new Map([
      ["abc", "[secret:SHORT]"],
      ["abcdef", "[secret:LONG]"],
    ]),
  );
  const first = redactOutput([line("prefix abc")], redactor);
  expect(first.lines).toEqual([{ level: "log", parts: [{ type: "text", text: "prefix " }] }]);
  expect(redactOutput([line("def tail")], redactor, first.pending).lines.flatMap((line) => line.parts)).toEqual([
    { type: "secret", name: "LONG" },
    { type: "text", text: " tail" },
  ]);
  const mismatch = redactOutput([line("ab"), line("x")], redactor);
  expect(mismatch.pending).toBeNull();
  expect(mismatch.lines.map((line) => line.parts)).toEqual([[{ type: "text", text: "ab" }], [{ type: "text", text: "x" }]]);
});

for (const boundary of ["line", "batch"] as const) {
  test(`harden Unicode output continuity at ${boundary} boundaries`, () => {
    const redactor = compileOutputRedaction(new Map([["ab😀cd", "[secret:TOKEN]"]]));
    const value = "ab😀cd";
    const left = line(value.slice(0, 3));
    const right = line(value.slice(3));
    const first = redactOutput([left], redactor);
    expect(first.lines.flatMap((line) => line.parts)).toEqual([]);
    const result = boundary === "batch" ? redactOutput([right], redactor, first.pending) : redactOutput([left, right], redactor);
    expect(result.lines.flatMap((line) => line.parts)).toEqual([{ type: "secret", name: "TOKEN" }]);
    expect(result.pending).toBeNull();
  });
}
