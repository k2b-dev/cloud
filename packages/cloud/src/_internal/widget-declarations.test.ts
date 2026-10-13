import { describe, expect, test } from "bun:test";
import type { WidgetEndpoint } from "../contracts/app";
import { WIDGET_ID_MAX_LENGTH } from "../contracts/widgets";
import { compileWidgetDeclarations } from "./widget-declarations";

const widget = (overrides: Partial<WidgetEndpoint> = {}): WidgetEndpoint => ({
  id: "stock",
  path: "/api/inventory/widget/stock",
  ...overrides,
});

describe("compileWidgetDeclarations", () => {
  test("accepts the longest invokable id and rejects ids Core cannot invoke", () => {
    const id = "a0:._-".repeat(32).slice(0, WIDGET_ID_MAX_LENGTH);
    expect(compileWidgetDeclarations("inventory", [widget({ id })])?.[0]?.id).toBe(id);
    for (const id of ["stock/summary", "Stock", "a".repeat(WIDGET_ID_MAX_LENGTH + 1)]) {
      expect(() => compileWidgetDeclarations("inventory", [widget({ id })])).toThrow(
        'id must use 1 to 188 lowercase letters, digits, ".", "_", "-", or ":" because Core invokes it as widget.read:<id>',
      );
    }
  });
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
    // `@` starts the size in a dashboard request, so `stock@small` could not be told apart from `stock` in small.
    fails([widget({ id: "stock@small" })], 'must not contain "@"');
    fails([widget({ title: "" })], "title must contain 1 to 80 characters");
    fails([widget({ description: "x".repeat(201) })], "description must contain 1 to 200 characters");
    fails([widget({ sizes: [] })], "distinct values");
    fails([widget({ sizes: ["small", "small"] })], "distinct values");
    fails([widget({ sizes: ["huge" as "small"] })], "distinct values");
    fails([widget({ sizes: ["small"], defaultSize: "large" })], "defaultSize it offers");
    // Without sizes a widget offers only `large`.
    fails([widget({ defaultSize: "small" })], "defaultSize it offers");
    fails([widget({ requiresRoles: ["root" as "admin"] })], "unknown role");
    // An app written in JavaScript gets no type check; a string would silently count as "not suggested".
    fails([widget({ suggest: "true" as unknown as boolean })], "suggest as true or false");
  });
});

describe("widget settings declarations", () => {
  test("rejects Object.prototype setting names at startup", () => {
    for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      expect(() => compileWidgetDeclarations("inventory", [widget({ settings: { [name]: { kind: "text", label: "Text" } } })])).toThrow(
        "Setting names must not be Object.prototype members",
      );
    }
  });
  test("compiles four kinds, trims presentation and copies choice options", () => {
    const declaration: WidgetEndpoint = widget({
      settings: {
        choice: { kind: "choice", label: " Choice ", options: [{ label: " First ", value: "one" }], default: "one" },
        space: { kind: "resource", label: " Space ", type: "spaces.space" },
        toggle: { kind: "toggle", label: " Toggle ", default: false },
        text: { kind: "text", label: " Text ", placeholder: " Hint ", maxLength: 200 },
      },
    });
    const compiled = compileWidgetDeclarations("inventory", [declaration])![0]!;
    expect(compiled.settings).toEqual({
      choice: { kind: "choice", label: "Choice", options: [{ label: "First", value: "one" }], default: "one" },
      space: { kind: "resource", label: "Space", type: "spaces.space" },
      toggle: { kind: "toggle", label: "Toggle", default: false },
      text: { kind: "text", label: "Text", placeholder: "Hint", maxLength: 200 },
    });
    expect(compiled.settings).not.toBe(declaration.settings);
    expect(compiled.settings?.choice).not.toBe(declaration.settings?.choice);
  });

  const option = { label: "One", value: "one" };
  const cases: { name: string; settings: unknown; setting: string }[] = [
    {
      name: "more than four fields",
      settings: Object.fromEntries(["one", "two", "three", "four", "five"].map((name) => [name, { kind: "text", label: "Text" }])),
      setting: "settings",
    },
    ...["Space", "space-id", "a".repeat(33), ""].map((name) => ({
      name: `invalid name ${name}`,
      settings: { [name]: { kind: "text", label: "Text" } },
      setting: name,
    })),
    { name: "unknown kind", settings: { field: { kind: "number", label: "Field" } }, setting: "field" },
    ...["", " ", "x".repeat(81)].flatMap((label) => [
      { name: `invalid field label ${label.length}`, settings: { field: { kind: "toggle", label } }, setting: "field" },
      {
        name: `invalid option label ${label.length}`,
        settings: { field: { kind: "choice", label: "Field", options: [{ ...option, label }] } },
        setting: "field",
      },
      {
        name: `invalid placeholder ${label.length}`,
        settings: { field: { kind: "text", label: "Field", placeholder: label } },
        setting: "field",
      },
    ]),
    { name: "zero options", settings: { field: { kind: "choice", label: "Field", options: [] } }, setting: "field" },
    {
      name: "seven options",
      settings: {
        field: { kind: "choice", label: "Field", options: Array.from({ length: 7 }, (_, i) => ({ label: "Option", value: String(i) })) },
      },
      setting: "field",
    },
    { name: "duplicate values", settings: { field: { kind: "choice", label: "Field", options: [option, option] } }, setting: "field" },
    ...["", "x".repeat(101), "a\nb", "a\u0085b"].map((value) => ({
      name: `invalid option value ${JSON.stringify(value)}`,
      settings: { field: { kind: "choice", label: "Field", options: [{ ...option, value }] } },
      setting: "field",
    })),
    {
      name: "undeclared choice default",
      settings: { field: { kind: "choice", label: "Field", options: [option], default: "two" } },
      setting: "field",
    },
    { name: "nonboolean default", settings: { field: { kind: "toggle", label: "Field", default: "true" } }, setting: "field" },
    ...[0, 201, 1.5, "20"].map((maxLength) => ({
      name: `invalid text maxLength ${maxLength}`,
      settings: { field: { kind: "text", label: "Field", maxLength } },
      setting: "field",
    })),
    { name: "missing resource type", settings: { field: { kind: "resource", label: "Field" } }, setting: "field" },
    ...["", "space", "Spaces.space"].map((type) => ({
      name: `invalid resource type ${type}`,
      settings: { field: { kind: "resource", label: "Field", type } },
      setting: "field",
    })),
  ];
  for (const { name, settings, setting } of cases)
    test(`rejects ${name} at startup with the declaration's identity`, () => {
      // JavaScript application declarations also pass through the startup compiler.
      const declaration = Object.defineProperty(widget(), "settings", { value: settings, enumerable: true });
      expect(() => compileWidgetDeclarations("inventory", [declaration])).toThrow(
        `Widget "stock" of app "inventory" setting ${JSON.stringify(setting)}`,
      );
    });
});
