import { describe, expect, test } from "bun:test";
import type { WidgetEndpoint } from "../contracts/app";
import { compileWidgetDeclarations } from "./widget-declarations";

const widget = (overrides: Partial<WidgetEndpoint> = {}): WidgetEndpoint => ({
  id: "stock",
  path: "/api/inventory/widget/stock",
  ...overrides,
});

describe("compileWidgetDeclarations", () => {
  test("keeps a valid declaration, trims its texts, and orders its sizes from small to large", () => {
    expect(
      compileWidgetDeclarations("inventory", [
        widget({ title: " Stock ", description: "Low stock.", sizes: ["large", "small"], defaultSize: "small", requiresRoles: ["admin"] }),
        { id: "legacy", path: "/legacy" },
      ]),
    ).toEqual([
      {
        id: "stock",
        path: "/api/inventory/widget/stock",
        title: "Stock",
        description: "Low stock.",
        sizes: ["small", "large"],
        defaultSize: "small",
        requiresRoles: ["admin"],
      },
      { id: "legacy", path: "/legacy", title: undefined, description: undefined, sizes: undefined, requiresRoles: undefined },
    ]);
    expect(compileWidgetDeclarations("inventory", undefined)).toBeUndefined();
  });

  test("fails at startup for a declaration the dashboard could not show as written", () => {
    const fails = (widgets: WidgetEndpoint[], message: string) =>
      expect(() => compileWidgetDeclarations("inventory", widgets)).toThrow(message);
    fails([widget(), widget()], "declared twice");
    fails([widget({ id: " " })], "non-empty id");
    fails([widget({ title: "" })], "title must contain 1 to 80 characters");
    fails([widget({ description: "x".repeat(201) })], "description must contain 1 to 200 characters");
    fails([widget({ sizes: [] })], "distinct values");
    fails([widget({ sizes: ["small", "small"] })], "distinct values");
    fails([widget({ sizes: ["huge" as "small"] })], "distinct values");
    fails([widget({ sizes: ["small"], defaultSize: "large" })], "defaultSize it offers");
    // Without sizes a widget offers only `large`.
    fails([widget({ defaultSize: "small" })], "defaultSize it offers");
    fails([widget({ requiresRoles: ["root" as "admin"] })], "unknown role");
  });
});
