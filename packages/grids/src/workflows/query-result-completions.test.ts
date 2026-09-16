import { expect, test } from "bun:test";
import { queryResultCompletions } from "./query-result-completions";

const suggest = (source: string) => {
  const caret = source.indexOf("|");
  return queryResultCompletions(source.replace("|", ""), caret);
};
const query = (name: string) => `- query: { source: 'from table Items', saveAs: ${name} }`;
test("suggests only prior query results, including while typing a quoted value", () => {
  expect(suggest(`steps:\n  ${query("report")}\n  - generateDocument:\n      data: \"re|\n  ${query("later")}\n`)).toEqual(["report"]);
  expect(suggest(`steps:\n  - generateDocument:\n      data: |\n  ${query("later")}\n`)).toEqual([]);
});

test("inherits outer results but does not leak branch or loop results", () => {
  for (const branch of [
    "if: true\n    then:",
    "switch: true\n    cases:\n      - when: true\n        do:",
    "forEach: items\n    as: item\n    do:",
  ]) {
    const indent = branch.includes("cases:") ? "          " : "      ";
    const prefix = `steps:\n  ${query("outer")}\n  - ${branch}\n${indent}${query("inner")}\n`;
    expect(suggest(`${prefix}${indent}- generateDocument:\n${indent}    data: |\n`)).toEqual(["outer", "inner"]);
    expect(suggest(`${prefix}  - generateDocument:\n      data: |\n`)).toEqual(["outer"]);
  }
});

test("excludes sibling branches and colliding or reserved names", () => {
  expect(
    suggest(`steps:\n  - if: true\n    then:\n      ${query("sibling")}\n    else:\n      - generateDocument:\n          data: |\n`),
  ).toEqual([]);
  expect(
    suggest(
      `inputs:\n  inputName: {type: text}\nsteps:\n  ${query("inputName")}\n  ${query("inputs")}\n  ${query("twice")}\n  ${query("twice")}\n  - generateDocument:\n      data: |\n`,
    ),
  ).toEqual(["inputName"]);
});

test("ignores data keys in templates, other actions, and malformed YAML", () => {
  expect(suggest(`steps:\n  ${query("report")}\n  - httpRequest:\n      data: |\n`)).toEqual([]);
  expect(suggest(`steps:\n  ${query("report")}\n  - generateDocument:\n      output:\n        body: >\n          data: |\n`)).toEqual([]);
  expect(suggest(`steps: []\nsteps:\n  - generateDocument:\n      data: |\n`)).toEqual([]);
});

test("does not offer loop aliases or results overwritten by another action", () => {
  expect(
    suggest(`steps:\n  ${query("report")}\n  - forEach: records\n    as: report\n    do:\n      - generateDocument:\n          data: |\n`),
  ).toEqual([]);
  expect(
    suggest(`steps:\n  ${query("report")}\n  - setVariable: {name: report, value: hello}\n  - generateDocument:\n      data: |\n`),
  ).toEqual([]);
});
