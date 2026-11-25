import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { indexClassGroups } from "./index-class-groups";

test("distributes equal-specificity classes without introducing descendant whitespace", () => {
  expect(indexClassGroups(".item:is(.one, .two){color:red}")).toBe(".item.one,.item.two{color:red}");
  expect(indexClassGroups(":is(.one,.two)>:is(.three,.four){color:red}")).toBe(".one>.three,.one>.four,.two>.three,.two>.four{color:red}");
  expect(indexClassGroups(".scope :-webkit-any(.one,.two){color:red}")).toBe(".scope .one,.scope .two{color:red}");
  expect(indexClassGroups(".scope:-moz-any(.one,.two){color:red}")).toBe(".scope.one,.scope.two{color:red}");
});

test("keeps one rule where the compatibility fallbacks of a class group become the same rule", () => {
  expect(indexClassGroups(":-webkit-any(.a,.b) .x{color:red}:-moz-any(.a,.b) .x{color:red}:is(.a,.b) .x{color:red}")).toBe(
    ".a .x,.b .x{color:red}",
  );
  // a repeat that is not one of these fallbacks, or another declaration, stays
  expect(indexClassGroups(".a .x{color:red}:is(.a,.b) .x{color:red}")).toBe(".a .x{color:red}.a .x,.b .x{color:red}");
  expect(indexClassGroups(":-webkit-any(.a,.b) .x{color:red}:is(.a,.b) .x{color:blue}")).toBe(
    ".a .x,.b .x{color:red}.a .x,.b .x{color:blue}",
  );
});

test("preserves specificity differences, nested groups, strings and declarations", () => {
  const css =
    ':is(#id,.one),:not(:is(.one,.two)),:where(.one,.two),:has(:is(.one,.two)),:is(.one,.two:hover),:is(.one,.two .three){--text:":is(.one,.two)";color:red}';
  expect(indexClassGroups(css)).toBe(css);
  expect(indexClassGroups("@media (width>1px){.scope:is(.one,.two){color:red}}")).toBe(
    "@media (width>1px){.scope.one,.scope.two{color:red}}",
  );
});

test("a consumer browser bundle does not recreate compatibility class groups", async () => {
  const compile = async (source: string) => {
    const result = await Bun.build({ entrypoints: ["fixture.css"], files: { "fixture.css": source }, target: "browser", minify: true });
    if (!result.success) throw new AggregateError(result.logs);
    const output = result.outputs[0];
    if (!output) throw new Error("Missing compiled stylesheet");
    return output.text();
  };
  const original = await compile(".scope:is(.one,.two){color:red}");
  expect(original).toContain("any(");
  const indexed = await compile(indexClassGroups(original));
  expect(indexed).not.toContain("any(");
  expect(indexed).not.toContain(":is(");
  expect(indexed).toContain(".scope.one");
  expect(indexed).toContain(".scope.two");
});

test("retains Cartesian products beyond the output budget", () => {
  const group = `:is(${Array.from({ length: 10 }, (_, index) => `.class-${index}`).join(",")})`;
  const css = `${group}${group}${group}{color:red}`;
  expect(indexClassGroups(css)).toBe(css);
});

test("the shipped stylesheet is indexed, including after a consumer browser bundle", async () => {
  const path = new URL("../dist/styles.css", import.meta.url).pathname;
  const css = await readFile(path, "utf8");
  expect(indexClassGroups(css)).toBe(css);
  const result = await Bun.build({ entrypoints: [path], target: "browser", minify: true });
  if (!result.success) throw new AggregateError(result.logs);
  const output = result.outputs[0];
  if (!output) throw new Error("Missing rebundled stylesheet");
  const rebundled = await output.text();
  // Complex and specificity-sensitive groups must remain. Only safe class groups are forbidden.
  expect(indexClassGroups(rebundled)).toBe(rebundled);
});
