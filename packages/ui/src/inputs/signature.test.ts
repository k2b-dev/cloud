import { describe, expect, test } from "bun:test";
import { drawingToSvg, parseSignature, type SignatureValue, strokeOutline, strokeWidth, svgToDrawing, typedToSvg } from "./signature";

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
    const drawing = { x: 0, y: 0, width: 320.04, height: 160, strokes: ["M0 0L1 1Z", "M2 2L3 3Z"] };
    const svg = drawingToSvg(drawing);
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160" width="320" height="160"><g fill="currentColor"><path d="M0 0L1 1Z"/><path d="M2 2L3 3Z"/></g></svg>',
    );
    expect(svgToDrawing(svg ?? "")).toEqual({ x: 0, y: 0, width: 320, height: 160, strokes: drawing.strokes });
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

  test("a drawing space that grew past the pad keeps its origin", () => {
    const svg = drawingToSvg({ x: -364.27, y: -12, width: 1084.5, height: 190, strokes: ["M-300 5L-290 6Z"] });
    expect(svg).toContain('viewBox="-364.3 -12 1084.5 190" width="1084.5" height="190"');
    expect(svgToDrawing(svg ?? "")).toEqual({ x: -364.3, y: -12, width: 1084.5, height: 190, strokes: ["M-300 5L-290 6Z"] });
  });

  test("text that XML cannot hold is dropped, so the SVG stays well-formed", () => {
    const svg = typedToSvg("Ada\u000bLove\ud800lace\uffff", "cursive");
    expect(svg).toContain(">AdaLovelace</text>");
  });
});

describe("parseSignature", () => {
  const drawn = drawingToSvg({ x: 0, y: 0, width: 300, height: 120, strokes: ["M1 1A2 2 0 1 0 5 1Z", "M-1.5 2Q3 4 5 6L7 8Z"] }) ?? "";
  const typed = typedToSvg(`Ada "Countess" Lovelace`, `"Segoe Script", cursive`, () => 400);

  test("reads the hidden input's JSON and a value object, and rebuilds the same markup", () => {
    const value: SignatureValue = { kind: "drawn", svg: drawn };
    expect(parseSignature(JSON.stringify(value))).toEqual(value);
    expect(parseSignature(value)).toEqual(value);
    expect(parseSignature({ kind: "typed", name: `  Ada "Countess" Lovelace `, svg: typed })).toEqual({
      kind: "typed",
      name: `Ada "Countess" Lovelace`,
      svg: typed,
    });
  });

  test("an empty, malformed, or foreign value is no signature", () => {
    for (const input of [
      "",
      "{",
      null,
      undefined,
      42,
      [],
      {},
      { kind: "drawn" },
      { kind: "image", svg: drawn },
      { kind: "typed", svg: typed },
    ]) {
      expect(parseSignature(input)).toBeNull();
    }
    expect(parseSignature({ kind: "typed", name: "\u0000 ", svg: typed })).toBeNull();
    expect(parseSignature({ kind: "drawn", svg: typed })).toBeNull();
  });

  test("markup the field does not write is rejected instead of passed on", () => {
    const attacks = [
      drawn.replace("<svg ", '<svg onload="alert(1)" '),
      drawn.replace("<g ", "<script>alert(1)</script><g "),
      drawn.replace('d="M1 1', 'd="M1 1" onclick="alert(1)'),
      drawn.replace("</g>", '<image href="https://example.com/x.png"/></g>'),
      drawn.replace('viewBox="0 0', 'viewBox="0 0 0'),
      drawn.replace('width="300"', 'width="300" style="x"'),
    ];
    for (const svg of attacks) expect(parseSignature({ kind: "drawn", svg })).toBeNull();
    expect(parseSignature({ kind: "typed", name: "Ada", svg: typed.replace(">Ada", "><tspan>Ada") })).toBeNull();
    expect(parseSignature({ kind: "typed", name: "Ada", svg: typed.replace("<text ", '<text onclick="x" ') })).toBeNull();
  });

  test("a typed value takes its name from the value and escapes it again", () => {
    const parsed = parseSignature({ kind: "typed", name: "<script>alert(1)</script>", svg: typed });
    expect(parsed?.svg).toContain(">&lt;script&gt;alert(1)&lt;/script&gt;</text>");
    expect(parsed?.svg).toContain('viewBox="0 0 424 77"');
    expect(parsed?.svg).toContain('font-family="&quot;Segoe Script&quot;, cursive"');
  });
});
