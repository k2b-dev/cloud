import { expect, test } from "bun:test";
import { cssSelectors, hasBeforeUnnamedSubject } from "./css-has-scope";

test("refuses :has() before a last part that names nothing", () => {
  for (const selector of [
    ":where(html:has(.shell) *)",
    ".a:has(> .b) > :not(.c)",
    ".a:has(> .b) > .c ~ *",
    ".a:has(+ .b) > :nth-last-child(1 of :not([popover]))",
    ".x:is([data-y], .a:has(~ .b) > *)::after",
    ".group\\/s-x:is(:where(.group\\/s):has(:is(input:placeholder-shown)) *)",
  ]) {
    expect([selector, hasBeforeUnnamedSubject(selector)]).toEqual([selector, true]);
  }
});

test("accepts a named last part and :has() on the subject itself", () => {
  for (const selector of [
    ".a:has(> .b) > .c",
    ".a:has(> .b) .c:not(.d)",
    "html:has(.shell) input:not([type='checkbox'])",
    ".a > .b ~ *",
    ".a > .b:has(.c)",
    ".a:has(.b) > :is(.c, .d):nth-last-child(1 of :not([popover]))",
    ":not(:has(> :not(.a))):has(> .b) > .c:not([data-d])",
  ]) {
    expect([selector, hasBeforeUnnamedSubject(selector)]).toEqual([selector, false]);
  }
});

test("reads every style rule's selector with its line and skips at-rules and comments", () => {
  const css = "/* .a:has(.b) * { } */\n@media (min-width: 1px) {\n  .a:has(.b) * {\n    color: red;\n  }\n}\n";
  expect(cssSelectors(css)).toEqual([{ selector: ".a:has(.b) *", line: 3 }]);
});
