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

  for (const href of [
    "/app/weather",
    "../weather",
    "./weather",
    "#forecast",
    "?location=one",
    "https://weather.example/forecast",
    "http://weather.example/forecast",
  ]) {
    test(`preserves safe widget links: ${href}`, () => {
      expect(WidgetResponseSchema.parse({ title: "Weather", href, blocks: [] }).href).toBe(href);
    });
  }

  for (const href of [
    "/\\evil",
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "vbscript:msgbox(1)",
    "file:///tmp/file",
    "/app/\nweather",
    "/app/\u0085weather",
  ]) {
    test(`rejects unsafe widget links: ${href}`, () => {
      expect(WidgetResponseSchema.safeParse({ title: "Unsafe", href, blocks: [] }).success).toBeFalse();
      expect(
        WidgetResponseSchema.safeParse({ title: "Unsafe", blocks: [{ kind: "list", items: [{ label: "item", href }] }] }).success,
      ).toBeFalse();
    });
  }

  test("strips extra fields at every widget object boundary", () => {
    expect(
      WidgetResponseSchema.parse({
        title: "Extra",
        html: "<script>",
        blocks: [{ kind: "list", extra: "ignored", items: [{ label: "Item", extra: "ignored" }] }],
      }),
    ).toEqual({ title: "Extra", blocks: [{ kind: "list", items: [{ label: "Item" }] }] });
  });

  test("retains collection and string bounds", () => {
    expect(WidgetResponseSchema.safeParse({ title: "x".repeat(501), blocks: [] }).success).toBeFalse();
    expect(
      WidgetResponseSchema.safeParse({
        title: "Many",
        blocks: Array.from({ length: 25 }, () => ({ kind: "placeholder", title: "Empty" })),
      }).success,
    ).toBeFalse();
  });
});
