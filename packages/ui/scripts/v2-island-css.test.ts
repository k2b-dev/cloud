import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transparentIslands } from "./v2-island-css";

const W = ":where(solid-island,solid-client)";

describe("transparentIslands", () => {
  test("a child relation also holds through one wrapper", () => {
    expect(transparentIslands(".k2-ui .a > .b{x:1}")).toBe(`.k2-ui :is(.a>.b,.a>${W}>.b){x:1}`);
  });

  test("a sibling relation holds with either side, or both, in a wrapper", () => {
    expect(transparentIslands(".a + .b{x:1}")).toBe(
      `:is(.a+.b,.a+${W}>.b:where(:first-child),${W}:has(>.a:where(:last-child))+.b,${W}:has(>.a:where(:last-child))+${W}>.b:where(:first-child)){x:1}`,
    );
  });

  test("first and last child count the wrapper's place; a pseudo-element stays at the end", () => {
    expect(transparentIslands(".b:last-child::after{x:1}")).toBe(`.b:last-child:where(:not(${W}>*),${W}:last-child>*)::after{x:1}`);
  });

  test("a compound without a class never matches the wrapper itself, an argument's subject is left to its compound", () => {
    expect(transparentIslands(".a > *{x:1}")).toBe(
      ":is(.a>*:where(:not(solid-island):not(solid-client)),.a>:where(solid-island,solid-client)>*:where(:not(solid-island):not(solid-client))){x:1}",
    );
    expect(transparentIslands(".a:not(:hover){x:1}")).toBe(".a:not(:hover){x:1}");
  });

  test(":has() looks through a wrapper, and past the wrapper of its anchor", () => {
    expect(transparentIslands(".r:has(> .l){x:1}")).toBe(`.r:has(>.l,>${W}>.l){x:1}`);
    expect(transparentIslands(".b:has(~ .c){x:1}")).toBe(`.b:is(:has(~.c,~${W}>.c),${W}:has(~.c,~${W}>.c)>*){x:1}`);
  });

  test("a rule without a relation, an at-rule and keyframes stay as written", () => {
    const css = "@media (width < 768px){.k2-ui .a{x:1}}@keyframes k{from{x:0}to{x:1}}";
    expect(transparentIslands(css)).toBe(css);
  });

  test("a form that cannot see through a wrapper fails, except on placeholders", () => {
    expect(() => transparentIslands(".a > .b:nth-child(2){x:1}")).toThrow(":nth-child");
    expect(() => transparentIslands(".a:empty{x:1}")).toThrow(":empty");
    expect(() => transparentIslands(".a:has(> .b + .c){x:1}")).toThrow("sibling relation inside :has()");
    expect(transparentIslands(".k2-lookup-skel > .k2-skel:nth-child(2){x:1}")).toContain(":nth-child(2)");
  });

  // The guard of the source: a new rule in v2.css that an island would break fails here and in the build.
  test("every rule of v2.css sees through a wrapper", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/v2/v2.css"), "utf8");
    expect(() => transparentIslands(source)).not.toThrow();
  });
});
