import { describe, expect, test } from "bun:test";
import { sizedSvg } from "./icon-svg";

describe("SVG logo sizing", () => {
  test("sizes the root and keeps the drawing's extent as the viewBox", () => {
    expect(sizedSvg('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20px"><rect/></svg>', 84)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" width="84" height="84"><rect/></svg>',
    );
    expect(sizedSvg("<svg viewBox='0 0 4 2' width='100%' height='100%'><rect/></svg>", 84)).toBe(
      '<svg viewBox=\'0 0 4 2\' width="84" height="84"><rect/></svg>',
    );
  });

  test("leaves a root without a viewBox and without pixel sizes as it is, instead of cropping it", () => {
    for (const svg of [
      '<svg width="100%" height="100%"><rect/></svg>',
      '<svg width="10cm" height="5cm"><rect/></svg>',
      '<svg stroke-width="2"><rect/></svg>',
    ]) {
      expect(sizedSvg(svg, 84)).toBe(svg);
    }
  });
});
