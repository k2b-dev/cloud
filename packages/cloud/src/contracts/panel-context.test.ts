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

test("the zod-free check accepts exactly what the schema accepts", async () => {
  const { isPanelPageContext } = await import("./panel-context-plain");
  const { PanelPageContextSchema } = await import("./panel-context");
  const base = { v: 1, seq: 4, pageId: "11111111-1111-4111-8111-111111111111", app: "mail" };
  const samples: unknown[] = [
    base,
    { ...base, scope: { type: "mail.mailbox", id: "Box001" }, help: ["mail-work"] },
    { ...base, scope: { type: "mail.mailbox", id: "x".repeat(512) }, help: ["a", "b", "c"] },
    { ...base, scope: { type: "m.x", id: "1" } },
    { ...base, app: "a".repeat(80) },
    { ...base, seq: Number.MAX_SAFE_INTEGER },
    { ...base, v: 2 },
    { ...base, seq: -1 },
    { ...base, seq: 1.5 },
    { ...base, seq: "1" },
    { ...base, pageId: "not-a-uuid" },
    { ...base, app: "Mail" },
    { ...base, app: "a".repeat(81) },
    { ...base, scope: { type: "mail", id: "1" } },
    { ...base, scope: { type: "mail.mailbox", id: "" } },
    { ...base, scope: { type: "mail.mailbox", id: "x".repeat(513) } },
    { ...base, scope: { type: "mail.mailbox", id: "1", title: "Leak" } },
    { ...base, scope: null },
    { ...base, scope: undefined },
    { ...base, help: [] },
    { ...base, help: ["a", "b", "c", "d"] },
    { ...base, help: ["Not-Kebab"] },
    { ...base, help: [""] },
    { ...base, help: ["a".repeat(181)] },
    { ...base, focus: { type: "mail.draft", id: "1" } },
    // A sparse array survives structured cloning; the check must reject it like the schema.
    { ...base, help: [, "mail-work"] },
    { ...base, help: new Array(1) },
    Object.assign(Object.create(null), base),
    [base],
    null,
    "context",
  ];
  for (const sample of samples)
    expect([sample, isPanelPageContext(sample)]).toEqual([sample, PanelPageContextSchema.safeParse(sample).success]);
});
