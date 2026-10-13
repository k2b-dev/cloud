import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { parseWidgetSettings } from "../_internal/widget-settings";
import { CLOUD_RESOURCE_ID_MAX_LENGTH } from "../contracts/capabilities";
import type { WidgetSettingsDeclaration } from "../contracts/widgets";
import { getWidgetRequest, setWidgetRequest, WIDGET_SETTINGS_PARAM, WIDGET_SETTINGS_PARAM_MAX_LENGTH } from "./widget-request";

const declaration: WidgetSettingsDeclaration = {
  choice: {
    kind: "choice",
    label: "Choice",
    options: [
      { label: "One", value: "one" },
      { label: "Two", value: "two" },
    ],
    default: "one",
  },
  toggle: { kind: "toggle", label: "Toggle", default: true },
  text: { kind: "text", label: "Text", maxLength: 8 },
  space: { kind: "resource", label: "Space", type: "spaces.space" },
};

describe("parseWidgetSettings", () => {
  test("keeps declared valid values, trims text and drops unknown names", () => {
    expect(
      parseWidgetSettings(declaration, {
        choice: "two",
        toggle: false,
        text: "  hello  ",
        space: { type: "spaces.space", id: "abc123" },
        unknown: true,
      }),
    ).toEqual({
      choice: "two",
      toggle: false,
      text: "hello",
      space: { type: "spaces.space", id: "abc123" },
    });
    expect(parseWidgetSettings(undefined, { text: "hello" })).toEqual({});
  });

  for (const raw of [
    undefined,
    null,
    true,
    "text",
    [],
    { choice: true, toggle: "true", text: false, space: "abc123" },
    { choice: "missing", toggle: null, text: "123456789", space: { type: "files.file", id: "abc123" } },
    { text: " ", space: { type: "spaces.space", id: "" } },
    { text: "a\nb", space: { type: "spaces.space", id: "abc123", extra: true } },
    { text: "a\u0085b" },
  ])
    test(`drops invalid values and fills defaults: ${JSON.stringify(raw)}`, () => {
      expect(parseWidgetSettings(declaration, raw)).toEqual({ choice: "one", toggle: true });
    });

  test("text defaults to a 200 character bound and checks controls before trimming", () => {
    const fields: WidgetSettingsDeclaration = { text: { kind: "text", label: "Text" } };
    expect(parseWidgetSettings(fields, { text: "x".repeat(200) })).toEqual({ text: "x".repeat(200) });
    expect(parseWidgetSettings(fields, { text: "x".repeat(201) })).toEqual({});
    expect(parseWidgetSettings(fields, { text: "\thello" })).toEqual({});
  });
});

describe("widget request context", () => {
  test("fully parses Core settings at the exact URL-encoded parameter budget", async () => {
    const names = ["one", "two", "three", "four"];
    const fields: WidgetSettingsDeclaration = Object.fromEntries(
      names.map((name) => [name, { kind: "resource", label: "Space", type: "spaces.space" }]),
    );
    // JSON and URL encoding give a quote six bytes, versus one for plain ASCII. Pad all four IDs to 512 characters.
    const ids = [512, 512, 146, 0].map((quotes) => '"'.repeat(quotes) + "a".repeat(CLOUD_RESOURCE_ID_MAX_LENGTH - quotes));
    const values = Object.fromEntries(names.map((name, i) => [name, { type: "spaces.space", id: ids[i] }]));
    const json = JSON.stringify(parseWidgetSettings(fields, values));
    const param = new URLSearchParams([[WIDGET_SETTINGS_PARAM, json]]).toString();
    expect(param.length - WIDGET_SETTINGS_PARAM.length - 1).toBe(WIDGET_SETTINGS_PARAM_MAX_LENGTH);
    const routes = new Hono().get("/resource", (c) => c.json(setWidgetRequest(c, { settings: fields })));
    expect(await (await routes.request(`/resource?${param}`)).json()).toEqual({ size: "large", settings: values });
  });

  const routes = new Hono()
    .get("/public", (c) => c.json(getWidgetRequest(c)))
    .get("/declared", (c) => {
      setWidgetRequest(c, { sizes: ["small", "large"], settings: declaration });
      return c.json(getWidgetRequest(c));
    })
    .get("/text", (c) => {
      setWidgetRequest(c, { settings: { text: { kind: "text", label: "Text" } } });
      return c.json(getWidgetRequest(c));
    })
    .get("/none", (c) => {
      setWidgetRequest(c, {});
      return c.json(getWidgetRequest(c));
    });

  test("records validated settings fitted to the declaration", async () => {
    const settings = encodeURIComponent(JSON.stringify({ text: " hello ", choice: "missing", toggle: false, unknown: "no" }));
    expect(await (await routes.request(`/declared?size=small&settings=${settings}`)).json()).toEqual({
      size: "small",
      settings: { choice: "one", toggle: false, text: "hello" },
    });
    expect(await (await routes.request(`/none?settings=${settings}`)).json()).toEqual({ size: "large", settings: {} });
    expect(await (await routes.request(`/public?size=small&settings=${settings}`)).json()).toEqual({ size: "large", settings: {} });
  });

  test("invalid JSON and an oversized parameter count as missing values", async () => {
    for (const value of ["{", JSON.stringify({ text: "ok" }) + " ".repeat(WIDGET_SETTINGS_PARAM_MAX_LENGTH)]) {
      expect(await (await routes.request(`/text?settings=${encodeURIComponent(value)}`)).json()).toEqual({ size: "large", settings: {} });
      expect(await (await routes.request(`/declared?settings=${encodeURIComponent(value)}`)).json()).toEqual({
        size: "large",
        settings: { choice: "one", toggle: true },
      });
    }
  });
});
