import { describe, expect, test } from "bun:test";
import { WidgetResponseSchema } from "./widgets";

describe("WidgetResponseSchema", () => {
  test("accepts the bounded widget block contract", () => {
    expect(
      WidgetResponseSchema.safeParse({
        title: "Weather",
        href: "/app/weather?location=one",
        blocks: [{ kind: "list", items: [{ label: "Berlin", href: "/app/weather/berlin" }] }],
      }).success,
    ).toBeTrue();
  });

  for (const href of ["https://evil.example", "//evil.example", "/\\evil", "javascript:alert(1)"]) {
    test(`rejects unsafe widget links: ${href}`, () => {
      expect(WidgetResponseSchema.safeParse({ title: "Unsafe", href, blocks: [] }).success).toBeFalse();
      expect(
        WidgetResponseSchema.safeParse({ title: "Unsafe", blocks: [{ kind: "list", items: [{ label: "item", href }] }] }).success,
      ).toBeFalse();
    });
  }

  test("rejects unknown fields and unbounded collections", () => {
    expect(WidgetResponseSchema.safeParse({ title: "Extra", blocks: [], html: "<script>" }).success).toBeFalse();
    expect(
      WidgetResponseSchema.safeParse({
        title: "Many",
        blocks: Array.from({ length: 25 }, () => ({ kind: "placeholder", title: "Empty" })),
      }).success,
    ).toBeFalse();
  });
});
