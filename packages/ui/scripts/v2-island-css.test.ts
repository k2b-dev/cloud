import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_EMPTY, transparentIslands } from "./v2-island-css";
import { v2Parts } from "./v2-parts";

const W = ":where(solid-island,solid-client)";
const E = ":where(solid-island:empty,solid-client:empty)";

describe("transparentIslands", () => {
  test("a child relation also holds through one wrapper", () => {
    // a list of whole selectors, one per way: a browser sorts each by its subject, which one `:is()` around them hides
    expect(transparentIslands(".k2-ui .a > .b{x:1}")).toBe(`.k2-ui .a>.b,\n.k2-ui .a>${W}>.b{x:1}`);
  });

  test("a sibling relation holds with either side, or both, in a wrapper", () => {
    const later = [`.a~.b`, `.a~${W}>.b`, `${W}:has(>.a)~.b`, `${W}:has(>.a)~${W}>.b`];
    expect(transparentIslands(".a ~ .b{x:1}")).toBe(`${later.join(",\n")}{x:1}`);
    // `+` keeps first and last in the wrapper, and steps over up to MAX_EMPTY empty wrappers, never over content
    const pairs = [
      [".a", ".b"],
      [".a", `${W}>.b:where(:first-child)`],
      [`${W}:has(>.a:where(:last-child))`, ".b"],
      [`${W}:has(>.a:where(:last-child))`, `${W}>.b:where(:first-child)`],
    ];
    const next = pairs.flatMap(([left, right]) => [0, 1, 2, 3].map((gap) => `${left}+${`${E}+`.repeat(gap)}${right}`));
    expect(MAX_EMPTY).toBe(3);
    expect(transparentIslands(".a + .b{x:1}")).toBe(`${next.join(",\n")}{x:1}`);
    // two parts of one primitive, marked as such, step over none
    const marked = pairs.map(([left, right]) => `${left}+${right}`);
    expect(transparentIslands("/* one primitive: a and b */.a + .b{x:1}")).toBe(`/* one primitive: a and b */${marked.join(",\n")}{x:1}`);
  });

  test("two sibling relations in a row fail the build", () => {
    expect(() => transparentIslands(".a + .b + .c{x:1}")).toThrow("two sibling relations");
    expect(() => transparentIslands(".a ~ .b ~ .c{x:1}")).toThrow("two sibling relations");
  });

  test("first and last child count the wrapper's place and skip empty wrappers; a pseudo-element stays at the end", () => {
    const last = `:nth-last-child(1 of :not(${E}))`;
    expect(transparentIslands(".b:last-child::after{x:1}")).toBe(`.b${last}:where(:not(${W}>*),${W}${last}>*)::after{x:1}`);
  });

  test("a compound without a class never matches the wrapper itself, an argument's subject is left to its compound", () => {
    expect(transparentIslands(".a > *{x:1}")).toBe(
      ".a>*:where(:not(solid-island):not(solid-client)),\n.a>:where(solid-island,solid-client)>*:where(:not(solid-island):not(solid-client)){x:1}",
    );
    expect(transparentIslands(".a:not(:hover){x:1}")).toBe(".a:not(:hover){x:1}");
  });

  test("inside :has() first and last child count the wrapper's place, but skip no empty wrapper", () => {
    // skipping would make WebKit check the :has() again on every change of the page (island-css-cost.browser.test.ts)
    const first = `:first-child:where(:not(${W}>*),${W}:first-child>*)`;
    expect(transparentIslands(".p:has(> .i:first-child){x:1}")).toBe(`.p:has(>.i${first},>${W}>.i${first}){x:1}`);
    // also inside a :not() inside :has()
    const seam = transparentIslands(".p:has(+ .s:not(:last-child)){x:1}");
    expect(seam).toContain(`.s:not(:last-child:where(:not(${W}>*),${W}:last-child>*))`);
    expect(seam).not.toContain(":nth-last-child");
  });

  test(":has() looks through a wrapper below its anchor", () => {
    expect(transparentIslands(".r:has(> .l){x:1}")).toBe(`.r:has(>.l,>${W}>.l){x:1}`);
    // never past the anchor's own wrapper: `W:has(~ …)` would restyle the whole island on every change in it
    expect(transparentIslands(".b:has(~ .c){x:1}")).toBe(`.b:has(~.c,~${W}>.c){x:1}`);
  });

  test("the last of some siblings counts like the last child: the wrapper's place, and empty wrappers count as none", () => {
    const last = `:nth-last-child(1 of :is(:not([popover])):not(${E}))`;
    expect(transparentIslands(".a > .b:nth-last-child(1 of :not([popover])){x:1}")).toBe(
      `.a>.b${last}:where(:not(${W}>*),${W}${last}>*),\n.a>${W}>.b${last}:where(:not(${W}>*),${W}${last}>*){x:1}`,
    );
  });

  test("a rule without a relation, an at-rule and keyframes stay as written", () => {
    const css = "@media (width < 768px){.k2-ui .a{x:1}}@keyframes k{from{x:0}to{x:1}}";
    expect(transparentIslands(css)).toBe(css);
  });

  test("a form that cannot see through a wrapper fails, except on placeholders", () => {
    expect(() => transparentIslands(".a > .b:nth-child(2){x:1}")).toThrow(":nth-child");
    expect(() => transparentIslands(".a:empty{x:1}")).toThrow(":empty");
    expect(() => transparentIslands(".a:has(> .b + .c){x:1}")).toThrow("sibling relation inside :has()");
    expect(() => transparentIslands(".a:has(> :is(.b + .c)){x:1}")).toThrow("sibling relation inside :has()");
    expect(() => transparentIslands(".a:has(> .x) + .b{x:1}")).toThrow(":has() before a sibling relation");
    expect(() => transparentIslands(".a > .b:\\66 irst-child{x:1}")).toThrow("escaped pseudo-class");
    expect(transparentIslands(".k2-lookup-skel > .k2-skel:nth-child(2){x:1}")).toContain(":nth-child(2)");
  });

  test("an inner part of a primitive is never in a wrapper: no way through one to it, from it or for its place", () => {
    const parts = new Set(["k2-lead", "k2-main"]);
    // a child relation to a part: as written; to anything else: also through a wrapper
    expect(transparentIslands(".k2-row > .k2-lead{x:1}", parts)).toBe(".k2-row>.k2-lead{x:1}");
    expect(transparentIslands(".k2-row:has(> .k2-lead){x:1}", parts)).toBe(".k2-row:has(>.k2-lead){x:1}");
    // between two parts only empty wrappers: an app's slot between them may hold islands that render nothing
    expect(transparentIslands(".k2-lead + .k2-main{x:1}", parts)).toBe(
      [0, 1, 2, 3].map((gap) => `.k2-lead+${`${E}+`.repeat(gap)}.k2-main`).join(",\n") + "{x:1}",
    );
    // a part beside app content: only the app's side may be in a wrapper
    expect(transparentIslands(".k2-x ~ .k2-main{x:1}", parts)).toBe(`.k2-x~.k2-main,\n${W}:has(>.k2-x)~.k2-main{x:1}`);
    expect(transparentIslands(".k2-lead ~ .k2-x{x:1}", parts)).toBe(`.k2-lead~.k2-x,\n.k2-lead~${W}>.k2-x{x:1}`);
    // its place among its siblings skips empty wrappers, but it never needs a wrapper's place
    expect(transparentIslands(".k2-row > .k2-lead:last-child{x:1}", parts)).toBe(`.k2-row>.k2-lead:nth-last-child(1 of :not(${E})){x:1}`);
  });

  test("an :is() or :where() whose every selector names something never matches the wrapper itself", () => {
    expect(transparentIslands(".a :where(.b, [data-c]){x:1}")).toBe(".a :where(.b,[data-c]){x:1}");
    expect(transparentIslands(".a :where(.b, *){x:1}")).toContain(":where(:not(solid-island):not(solid-client))");
  });

  test("the inner parts are the classes v2's components put inside their own elements, never a component's root", () => {
    const parts = v2Parts();
    for (const part of ["k2-seam", "k2-scroll", "k2-row-lead", "k2-bar-start", "k2-bar-end", "k2-ws-main", "k2-sh"])
      expect(parts).toContain(part);
    for (const root of ["k2-btn", "k2-row", "k2-pane", "k2-sec", "k2-bar", "k2-icon", "k2-ui", "k2-t-meta"])
      expect(parts).not.toContain(root);
  });

  // The guard of the source: a new rule in v2.css that an island would break fails here and in the build.
  test("every rule of v2.css sees through a wrapper", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/v2/v2.css"), "utf8");
    expect(() => transparentIslands(source)).not.toThrow();
  });
});
