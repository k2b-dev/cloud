import { describe, expect, test } from "bun:test";
import { drawingToSvg, strokeOutline, strokeWidth, svgToDrawing, typedToSvg } from "./signature";

describe("signature geometry", () => {
  test("a tap is a round dot of the stroke width", () => {
    expect(strokeOutline([{ x: 10, y: 20, pressure: 1 }], 4)).toBe("M8 20A2 2 0 1 0 12 20A2 2 0 1 0 8 20Z");
    expect(strokeOutline([], 4)).toBe("");
  });

  test("a line is one closed outline whose width follows the pressure", () => {
    const outline = strokeOutline(
      [
        { x: 0, y: 0, pressure: 1 },
        { x: 10, y: 0, pressure: 1 },
        { x: 20, y: 0, pressure: 0 },
      ],
      4,
    );
    expect(outline.startsWith("M0 2")).toBeTrue();
    expect(outline.endsWith("Z")).toBeTrue();
    // Both ends get a round cap with the local radius.
    expect(outline).toContain(`A${strokeWidth(4, 0) / 2} ${strokeWidth(4, 0) / 2} 0 0 0 20 -0.7`);
    expect(outline).toContain("A2 2 0 0 0 0 2Z");
    expect(strokeWidth(4, 2)).toBe(4);
    expect(strokeWidth(4, -1)).toBeCloseTo(1.4);
  });
});

describe("signature SVG", () => {
  test("a drawing round-trips through its SVG, and an empty drawing has no value", () => {
    const drawing = { width: 320.04, height: 160, strokes: ["M0 0L1 1Z", "M2 2L3 3Z"] };
    const svg = drawingToSvg(drawing);
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160" width="320" height="160"><g fill="currentColor"><path d="M0 0L1 1Z"/><path d="M2 2L3 3Z"/></g></svg>',
    );
    expect(svgToDrawing(svg ?? "")).toEqual({ width: 320, height: 160, strokes: drawing.strokes });
    expect(drawingToSvg({ ...drawing, strokes: [] })).toBeNull();
    expect(svgToDrawing("<svg></svg>")).toBeNull();
  });

  test("a typed name is escaped and laid out to its measured width", () => {
    const svg = typedToSvg(`Ada "<x>" & Co`, `"Segoe Script", cursive`, (text) => text.length * 10);
    expect(svg).toContain('viewBox="0 0 164 77"');
    expect(svg).toContain('font-family="&quot;Segoe Script&quot;, cursive"');
    expect(svg).toContain(">Ada &quot;&lt;x&gt;&quot; &amp; Co</text>");
    expect(svg).not.toContain("<x>");
    // Without a measurement the width is estimated from the length.
    expect(typedToSvg("Ada", "cursive")).toContain('viewBox="0 0 96 77"');
  });
});
