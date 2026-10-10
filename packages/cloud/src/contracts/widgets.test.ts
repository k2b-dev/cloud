import { describe, expect, test } from "bun:test";
import { fitWidgetSize, resolveWidgetSizes, WidgetResponseSchema } from "./widgets";

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

describe("widget sizes", () => {
  test("a widget without sizes offers only large, and starts at its largest offered size", () => {
    expect(resolveWidgetSizes({})).toEqual({ sizes: ["large"], defaultSize: "large" });
    expect(resolveWidgetSizes({ sizes: ["medium", "small"] })).toEqual({ sizes: ["small", "medium"], defaultSize: "medium" });
    expect(resolveWidgetSizes({ sizes: ["small", "medium"], defaultSize: "small" })).toEqual({
      sizes: ["small", "medium"],
      defaultSize: "small",
    });
    expect(resolveWidgetSizes({ sizes: ["huge"], defaultSize: "small" })).toEqual({ sizes: ["large"], defaultSize: "large" });
  });

  test("a request gets the size it asks for only when the widget offers it", () => {
    const widget = { sizes: ["small", "medium"] as const, defaultSize: "small" as const };
    expect(fitWidgetSize("medium", widget)).toBe("medium");
    expect(fitWidgetSize("large", widget)).toBe("small");
    expect(fitWidgetSize(undefined, widget)).toBe("small");
  });
});
