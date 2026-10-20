import { expect, test } from "bun:test";
import {
  HELP_SHORTCUT_DESCRIPTION_MAX_LENGTH,
  HELP_SHORTCUT_ID_MAX_LENGTH,
  HELP_SHORTCUT_KEYS_MAX_LENGTH,
  HELP_SHORTCUT_TITLE_MAX_LENGTH,
  HELP_START_SHORTCUT_LIMIT,
} from "../ssr/layout-help-start";
import { CLOUD_RESOURCE_ID_MAX_LENGTH, CloudResourceRefSchema } from "./capabilities";
import {
  encodePanelContextParam,
  isPanelContextMessage,
  PANEL_CONTEXT_PARAM,
  PANEL_CONTEXT_PARAM_MAX_LENGTH,
  PanelContextMessageSchema,
  type PanelPageContext,
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
  const noShortcuts: "shortcuts" extends keyof PanelPageContext ? never : true = true;
  expect(noShortcuts).toBe(true);
  for (const value of [
    { ...context, focus: context.scope },
    { ...context, title: "Private" },
    { ...context, shortcuts: [] },
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
  for (const href of [
    "https://elsewhere.test/",
    "//elsewhere.test/",
    "/\\elsewhere.test/",
    "/\t/elsewhere.test/",
    "/.//elsewhere.test/",
    "/app/..//elsewhere.test/",
    "relative",
  ])
    expect(() => withPanelContext(href, context)).toThrow();
  // A browser keeps a raw backslash in the query and fragment; withdrawal must still clean such an address.
  expect(withPanelContext(`/app/panel?q=C:\\Users&${PANEL_CONTEXT_PARAM}=%7B%7D#a\\b`, null)).toBe("/app/panel?q=C%3A%5CUsers#a\\b");
});

test("Core alone skips consent; the context message has three required keys and only shortcuts as an optional fourth", () => {
  expect(panelProviderNeedsConsent("core")).toBe(false);
  for (const app of ["help", "mail", "inventory"]) expect(panelProviderNeedsConsent(app)).toBe(true);
  const message = { type: "cloud.panel.context", v: 1, context };
  expect(isPanelContextMessage(message)).toBe(true);
  expect(isPanelContextMessage({ ...message, context: null })).toBe(true);
  expect(isPanelContextMessage({ ...message, shortcuts: [] })).toBe(true);
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

const shortcut = { id: "mail.edit", title: "Edit Ada", shortcut: "mod+e" };
const validShortcutLists = [
  [],
  [shortcut],
  [{ ...shortcut, description: "Edit the selected contact" }],
  [{ ...shortcut, scope: "selection" }],
  [{ ...shortcut, description: "Edit the selected contact", scope: "selection" }],
  [{ ...shortcut, description: "", scope: "page" }],
  [{ ...shortcut, description: undefined, scope: undefined }],
  [
    {
      ...shortcut,
      id: "i".repeat(HELP_SHORTCUT_ID_MAX_LENGTH),
      title: "t".repeat(HELP_SHORTCUT_TITLE_MAX_LENGTH),
      description: "d".repeat(HELP_SHORTCUT_DESCRIPTION_MAX_LENGTH),
      shortcut: "k".repeat(HELP_SHORTCUT_KEYS_MAX_LENGTH),
    },
  ],
  Array.from({ length: HELP_START_SHORTCUT_LIMIT }, () => shortcut),
];
const invalidShortcutLists: unknown[] = [
  [{ ...shortcut, extra: "private" }],
  [shortcut, { ...shortcut, extra: "private" }],
  [, shortcut],
  new Array(1),
  Array.from({ length: HELP_START_SHORTCUT_LIMIT + 1 }, () => shortcut),
  ...(
    [
      ["id", HELP_SHORTCUT_ID_MAX_LENGTH],
      ["title", HELP_SHORTCUT_TITLE_MAX_LENGTH],
      ["description", HELP_SHORTCUT_DESCRIPTION_MAX_LENGTH],
      ["shortcut", HELP_SHORTCUT_KEYS_MAX_LENGTH],
    ] as const
  ).map(([key, max]) => [{ ...shortcut, [key]: "x".repeat(max + 1) }]),
  ...["id", "title", "shortcut"].flatMap((key) => [
    [{ ...shortcut, [key]: "" }],
    [{ ...shortcut, [key]: undefined }],
    [{ ...shortcut, [key]: 1 }],
  ]),
  [{ ...shortcut, scope: "everywhere" }],
  [{ ...shortcut, scope: null }],
  [{ ...shortcut, description: null }],
  [{ ...shortcut, description: 42 }],
  [null],
  null,
  {},
  "shortcuts",
];

test("message shortcuts have exact items and reject the whole list on malformed or oversized input", () => {
  const message = { type: "cloud.panel.context", v: 1, context };
  for (const shortcuts of validShortcutLists) {
    expect(PanelContextMessageSchema.safeParse({ ...message, shortcuts }).success).toBe(true);
    expect(PanelContextMessageSchema.safeParse({ ...message, context: null, shortcuts }).success).toBe(false);
  }
  for (const shortcuts of invalidShortcutLists) expect(PanelContextMessageSchema.safeParse({ ...message, shortcuts }).success).toBe(false);
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
  const message = { type: "cloud.panel.context", v: 1, context };
  const messages: unknown[] = [
    ...samples.map((context) => ({ ...message, context })),
    ...[...validShortcutLists, ...invalidShortcutLists, undefined].flatMap((shortcuts) => [
      { ...message, shortcuts },
      { ...message, context: null, shortcuts },
    ]),
    { ...message, v: 2 },
    { ...message, extra: true },
    [],
    null,
    "message",
  ];
  for (const sample of messages)
    expect([sample, isPanelContextMessage(sample)]).toEqual([sample, PanelContextMessageSchema.safeParse(sample).success]);
});
