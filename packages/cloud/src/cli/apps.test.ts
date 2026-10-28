import { expect, spyOn, test } from "bun:test";
import type { AppDetails } from "../contracts/app-details";
import apps from "./apps";
import type { CloudCliContext, CloudCliFlags, CloudCliOutputMode } from "./index";

const fixture: AppDetails = {
  app: { id: "demo", name: "Demo", description: "Demo app", icon: "box", accent: null, online: true },
  access: { kind: "roles", roles: ["admin"], grantCount: null, platformPermissions: ["mail:send"] },
  sends: [
    {
      type: "demo.changed",
      version: 1,
      title: "Changed",
      description: "Changed",
      subject: "demo.item",
      place: null,
      automation: true,
      subscriberCount: 1,
    },
  ],
  hears: [
    {
      subscriptionId: "demo-hears",
      eventType: "demo.changed",
      version: 1,
      publisherAppId: "demo",
      title: "Changed",
      state: "active",
      reason: null,
      firstSeenAt: "2026-10-27T12:00:00.000Z",
      isNew: true,
      counts: { pending: 0, retrying: 0, done: 0, failed: 8, cancelled: 0 },
      failedDeliveries: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          eventId: "00000000-0000-4000-8000-000000000002",
          code: "fixture_error",
          lastError: "Failure",
          attempts: 8,
          lastAttemptAt: "2026-10-27T12:00:00.000Z",
        },
      ],
    },
  ],
  notifications: [
    {
      id: "demo.notice",
      kind: "notice",
      label: "Notice",
      description: "Notice description",
      recipientKind: "user",
      requiredChannels: ["browser"],
      recommendedChannels: ["email"],
    },
  ],
  totals: { sends: 1, hears: 1, notifications: 1 },
};

const context = (
  args: string[],
  flags: CloudCliFlags = {},
  output: CloudCliOutputMode = "json",
  respond: (path: string) => Response = () => Response.json(fixture),
) => {
  const requests: { path: string; init?: RequestInit }[] = [];
  const printed: unknown[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "https://cloud.test", token: "fixture", output },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      requests.push({ path, init });
      return respond(path);
    },
    readJson: async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      return response.json();
    },
    print: (value) => {
      printed.push(value);
    },
    write: async (value) => {
      printed.push(value);
    },
    error: (value) => {
      printed.push(value);
    },
    json: (value) => {
      printed.push(value);
    },
    jsonLine: (value) => {
      printed.push(value);
    },
    table: (value) => {
      printed.push(value);
    },
  };
  return { ctx, requests, printed };
};

test.each(["json", "jsonl"] as const)("show preserves the complete %s service payload", async (output) => {
  const result = context(["show", "demo"], {}, output);
  await apps.run(result.ctx);
  expect(result.requests).toEqual([{ path: "/api/app-events/apps/demo", init: undefined }]);
  expect(result.printed).toEqual([fixture]);
});

test("show text groups app, access, sends, hears and notifications with new and failure markers", async () => {
  const result = context(["show", "demo"], {}, "text");
  await apps.run(result.ctx);
  const output = result.printed.join("\n");
  for (const text of [
    "App: Demo (demo)",
    "Access: roles",
    "Roles: admin",
    "mail:send",
    "Sends (1/1)",
    "Hears (1/1)",
    "new",
    "8 failed",
    "Notifications (1/1)",
    "Required: browser",
    "recommended: email",
    fixture.hears[0]!.failedDeliveries[0]!.id,
  ])
    expect(output).toContain(text);
  result.ctx.options.locale = "de-CH";
  result.printed.length = 0;
  await apps.run(result.ctx);
  expect(result.printed.join("\n")).toContain("neu · 8 fehlgeschlagen");
});

test("show encodes app IDs and propagates missing/forbidden responses", async () => {
  const encoded = context(["show", "a/b"]);
  await apps.run(encoded.ctx);
  expect(encoded.requests[0]?.path).toBe("/api/app-events/apps/a%2Fb");
  for (const status of [403, 404]) {
    const result = context(["show", "missing"], {}, "json", () => Response.json({ code: "denied" }, { status }));
    await expect(apps.run(result.ctx)).rejects.toThrow(String(status));
    expect(result.printed).toEqual([]);
  }
});

test("show help and missing arguments never call the server", async () => {
  const help = context(["show"], { help: true }, "text");
  help.ctx.options.locale = "de";
  await apps.run(help.ctx);
  expect(help.printed.join("\n")).toContain("App-ID");
  expect(help.requests).toEqual([]);
  const missing = context(["show"]);
  await expect(apps.run(missing.ctx)).rejects.toThrow();
  expect(missing.requests).toEqual([]);
});

test.each(["text", "json", "jsonl"] as const)("list uses the shared %s output mode and preserves the payload", async (output) => {
  const payload = {
    items: [{ id: "demo", name: "Demo", description: "Demo app", icon: "box", href: "/demo" }],
  };
  const result = context(["list"], { search: "a & b" }, output, () => Response.json(payload));
  const table = spyOn(result.ctx, "table");
  const json = spyOn(result.ctx, "json");
  const jsonLine = spyOn(result.ctx, "jsonLine");
  await apps.run(result.ctx);
  expect(result.requests).toEqual([{ path: "/api/apps?search=a+%26+b", init: undefined }]);
  expect(table).toHaveBeenCalledTimes(output === "text" ? 1 : 0);
  expect(json).toHaveBeenCalledTimes(output === "json" ? 1 : 0);
  expect(jsonLine).toHaveBeenCalledTimes(output === "jsonl" ? 1 : 0);
  expect(result.printed).toEqual([output === "text" ? payload.items : payload]);
});

test("show localizes human-facing status, automation and fallback failure text", async () => {
  const payload = structuredClone(fixture);
  payload.hears[0]!.failedDeliveries[0]!.code = null;
  const result = context(["show", "demo"], {}, "text", () => Response.json(payload));
  result.ctx.options.locale = "de-CH";
  for (const online of [true, false]) {
    payload.app.online = online;
    result.printed.length = 0;
    await apps.run(result.ctx);
    const output = result.printed.join("\n");
    expect(output).toContain(`Anwendung: Demo (demo) · ${online ? "erreichbar" : "nicht erreichbar"}`);
    expect(output).toContain("Automatisierung=ja");
    expect(output).toContain(`${fixture.hears[0]!.failedDeliveries[0]!.id} · fehlgeschlagen · 8 Versuche`);
  }
  payload.sends[0]!.automation = false;
  result.printed.length = 0;
  await apps.run(result.ctx);
  expect(result.printed.join("\n")).toContain("Automatisierung=nein");
});

test("show discloses how many entries each bounded list omits", async () => {
  const payload = { ...fixture, totals: { sends: 3, hears: 4, notifications: 5 } };
  const result = context(["show", "demo"], {}, "text", () => Response.json(payload));
  await apps.run(result.ctx);
  for (const omitted of [2, 3, 4]) expect(result.printed.join("\n")).toContain(`… ${omitted} more omitted`);
  result.ctx.options.locale = "de";
  result.printed.length = 0;
  await apps.run(result.ctx);
  for (const omitted of [2, 3, 4]) expect(result.printed.join("\n")).toContain(`… ${omitted} weitere ausgelassen`);
});
