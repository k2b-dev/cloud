import { expect, test } from "bun:test";
import { safeColor } from "./colors";

// A colour for each theme: `light-dark()` of two colours keeps a data colour at its contrast in light and in dark. Both
// sides are colours of the accepted forms themselves; nothing else gets through the pair.
test("light-dark() of two colours is a colour, each side checked", () => {
  expect(safeColor("light-dark(#1d4ed8, #93c5fd)")).toBe("light-dark(#1d4ed8, #93c5fd)");
  expect(safeColor(" light-dark( #b45309 ,var(--k2-amber) ) ")).toBe("light-dark(#b45309, var(--k2-amber))");
  expect(safeColor("light-dark(oklch(0.62 0.19 264), #fff)")).toBe("light-dark(oklch(0.62 0.19 264), #fff)");
  for (const color of [
    "light-dark(#1d4ed8)",
    "light-dark(#1d4ed8, #93c5fd, #000)",
    "light-dark(#1d4ed8, red)",
    "light-dark(#1d4ed8, url(https://example.org/x.png))",
    "light-dark(#1d4ed8, #93c5fd);background:url(https://example.org/x.png)",
    "light-dark(light-dark(#000, #fff), #fff)",
    "light-dark(#1d4ed8), url(x), light-dark(#93c5fd)",
    "light-dark(#1d4ed8, #93c5fd))",
  ])
    expect(safeColor(color)).toBeUndefined();
});
