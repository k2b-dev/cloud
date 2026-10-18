import { expect, test } from "bun:test";
import { CLOUD_RESOURCE_ID_MAX_LENGTH, CloudResourceRefSchema } from "./capabilities";
import {
  encodePanelContextParam,
  isPanelContextMessage,
  PANEL_CONTEXT_PARAM,
  PANEL_CONTEXT_PARAM_MAX_LENGTH,
  PanelPageContextSchema,
  panelProviderNeedsConsent,
  parsePanelContextParam,
  withPanelContext,
} from "./panel-context";

export const context = {
  v: 1 as const,
  seq: 0,
  pageId: "11111111-1111-4111-8111-111111111111",
  app: "mail",
  scope: { type: "mail.mailbox", id: "Box001" },
  help: ["mailbox"],
};

test("v1 contains only the place and bounded Help ids, with exact shapes", () => {
  expect(PanelPageContextSchema.parse(context)).toEqual(context);
  for (const value of [
    { ...context, focus: context.scope },
    { ...context, title: "Private" },
    { ...context, v: 2 },
    { ...context, seq: -1 },
    { ...context, seq: 0.1 },
    { ...context, seq: Number.MAX_SAFE_INTEGER + 1 },
    { ...context, pageId: "bad" },
    { ...context, app: "Mail" },
    { ...context, help: [] },
    { ...context, help: ["a", "b", "c", "d"] },
    { ...context, help: ["app/article"] },
    { ...context, help: ["a".repeat(181)] },
    { ...context, scope: { ...context.scope, title: "Private" } },
    { ...context, scope: { type: "mail.mailbox", id: "" } },
    { ...context, scope: { type: "mailbox", id: "box" } },
  ])
    expect(PanelPageContextSchema.safeParse(value).success).toBe(false);
});

test("URL parsing never throws and rejects malformed, forged and oversized parameters", () => {
  expect(parsePanelContextParam(encodePanelContextParam(context))).toEqual(context);
  for (const value of [
    null,
    undefined,
    "",
    "{",
    "null",
    "[]",
    JSON.stringify({ ...context, grant: "all" }),
    " ".repeat(PANEL_CONTEXT_PARAM_MAX_LENGTH + 1),
  ])
    expect(parsePanelContextParam(value)).toBeNull();
  const worst = {
    ...context,
    scope: CloudResourceRefSchema.parse({ type: `mail.${"a".repeat(175)}`, id: "\u0000".repeat(CLOUD_RESOURCE_ID_MAX_LENGTH) }),
    help: ["a".repeat(180), "b".repeat(180), "c".repeat(180)],
  };
  const encoded = encodePanelContextParam(worst);
  expect(encoded.length).toBeLessThanOrEqual(PANEL_CONTEXT_PARAM_MAX_LENGTH);
  expect(parsePanelContextParam(encoded)).toEqual(worst);
});

test("URL context replaces reserved input, preserving other query parameters and the hash", () => {
  const href = withPanelContext(`/app/panel?q=hello&${PANEL_CONTEXT_PARAM}=forged#article`, context);
  const url = new URL(href, "https://cloud.test");
  expect(url.searchParams.get("q")).toBe("hello");
  expect(url.hash).toBe("#article");
  expect(url.searchParams.getAll(PANEL_CONTEXT_PARAM)).toHaveLength(1);
  expect(parsePanelContextParam(url.searchParams.get(PANEL_CONTEXT_PARAM))).toEqual(context);
  expect(withPanelContext(href, null)).toBe("/app/panel?q=hello#article");
  for (const href of ["https://elsewhere.test/", "//elsewhere.test/", "/\\elsewhere.test/", "relative"])
    expect(() => withPanelContext(href, context)).toThrow();
});

test("Core alone skips consent; the context message has exactly three keys", () => {
  expect(panelProviderNeedsConsent("core")).toBe(false);
  for (const app of ["help", "mail", "inventory"]) expect(panelProviderNeedsConsent(app)).toBe(true);
  const message = { type: "cloud.panel.context", v: 1, context };
  expect(isPanelContextMessage(message)).toBe(true);
  expect(isPanelContextMessage({ ...message, context: null })).toBe(true);
  const inherited = Object.create(message);
  Object.defineProperties(inherited, { a: { value: 1 }, b: { value: 2 }, c: { value: 3 } });
  for (const value of [
    [],
    inherited,
    { ...message, v: 2 },
    { ...message, extra: true },
    { ...message, [Symbol()]: true },
    { ...message, context: { ...context, text: "secret" } },
  ])
    expect(isPanelContextMessage(value)).toBe(false);
});
