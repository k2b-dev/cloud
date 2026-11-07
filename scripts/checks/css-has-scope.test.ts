import { expect, test } from "bun:test";
import { cssSelectors, hasBeforeUnnamedSubject, pageWideHas } from "./css-has-scope";

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

test("resolves nested rules against their parent", () => {
  const css = ".a:has(.b), .c {\n  color: red;\n  @media (min-width: 1px) {\n    & .d { color: blue; }\n    .e { color: green; }\n  }\n}\n";
  expect(cssSelectors(css).map((entry) => entry.selector)).toEqual([".a:has(.b), .c", ":is(.a:has(.b), .c) .d", ":is(.a:has(.b), .c) .e"]);
  // Each `&` may match any parent selector.
  const pair = cssSelectors(".local:has(.x), .k2b-button {\n  & + & { color: red; }\n}\n").at(-1)!.selector;
  expect(pageWideHas(pair)).toBe("repeated");
  const wrapped = cssSelectors(".layout-shell-content {\n  &:has(.x) {\n    & .rare { color: red; }\n  }\n}\n").at(-1)!.selector;
  expect(pageWideHas(wrapped)).toBe("anchor");
});

test("refuses :has() that restyles the page on every DOM change", () => {
  for (const [selector, reason] of [
    ["html:has(.k2b-mobile-shell) .k2b-field__label", "anchor"],
    [":root:has(script[data-nav]) .layout-header-title", "anchor"],
    [".k2b-ui:has(.k2b-page-title:not([data-fallback])) .k2b-app-workspace__head", "anchor"],
    [".k2b-ui:not(:has(.k2b-page-title)) .k2b-app-workspace__head > .k2b-app-workspace__head-views", "anchor"],
    [".k2b-app-workspace:has(> .k2b-app-workspace__sidebar [aria-current]) > .k2b-app-workspace__head", "anchor"],
    [":is(.layout-content-main:has(.k2b-app-workspace)) .k2b-app-workspace", "anchor"],
    [".k2b-button:has(> .k2b-button__busy) > .k2b-button__label", "repeated"],
    [".a:has(+ .b:focus-visible) > :is(.k2b-button, .k2b-dropdown)", "repeated"],
    [".a:has(.b) i", "repeated"],
  ] as const) {
    expect([selector, pageWideHas(selector)]).toEqual([selector, reason]);
  }
});

test("accepts :has() on the styled element, a direct child of a page anchor, and a small local anchor", () => {
  for (const selector of [
    "html:has(> body > .cloud-app-canvas[data-layout-full-page])",
    ".layout-content-main:not(:has(.k2b-app-workspace))",
    "html[data-k2b-mobile-shell] .k2b-button",
    ".k2b-app-workspace:has(> .k2b-app-workspace__sidebar:not([hidden])) > .k2b-app-workspace__head",
    ".k2b-app-workspace__head:has(~ .k2b-app-workspace__content .k2b-app-workspace__main h1) > .k2b-app-workspace__head-lead",
    ".k2b-button > .k2b-button__label:has(+ .k2b-button__busy)",
    ".k2b-tab-bar:has(a[data-k2b-pending]) a[aria-current='page']",
    ".local:has(.x) .rare:not(.k2b-button)",
  ]) {
    expect([selector, pageWideHas(selector)]).toEqual([selector, undefined]);
  }
});
