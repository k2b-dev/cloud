import { afterEach, expect, test } from "bun:test";
import { launchPulseSqlAssistant } from "./pulse-assistant-launch";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const capture = () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = Object.assign(
    async (request: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: String(request), body: JSON.parse(String(init?.body)) });
      return Response.json({ id: "Cht001", draft: { content: [], revision: 1, updatedAt: null } }, { status: 201 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return calls;
};
test("launches one unsent draft with exact Pulse resource, skill and query tools", async () => {
  const calls = capture();
  const launched = await launchPulseSqlAssistant({
    base: { id: "Base01", name: "Betrieb" },
    sql: "SELECT :host",
    params: { host: "web-01" },
    queryName: "CPU",
    locale: "de",
  });
  expect(launched.href).toBe("/app/assistant?conversation=Cht001");
  expect(calls).toEqual([
    {
      path: "/api/ai/conversations",
      body: {
        launchedByAppId: "pulse",
        title: "CPU · Betrieb",
        skills: ["cloud-pulse"],
        preloadTools: [
          { appId: "pulse", kind: "query", id: "sql.run" },
          { appId: "pulse", kind: "query", id: "base.read" },
          { appId: "pulse", kind: "query", id: "source.list" },
        ],
        draft: {
          content: [
            { type: "text", text: "Hilf mir mit dieser Pulse-Abfrage.\n\n```sql\nSELECT :host\n```\nhost = web-01" },
            {
              type: "resource",
              ref: { type: "pulse.base", id: "Base01" },
              title: "Betrieb",
              icon: "ti ti-activity-heartbeat",
              href: "/app/pulse/Base01",
            },
          ],
        },
      },
    },
  ]);
});
test("localizes new-query titles for unsaved and empty consoles, with every parameter value", async () => {
  for (const [locale, title] of [
    ["en", "New query"],
    ["de", "Neue Abfrage"],
  ]) {
    const calls = capture();
    await launchPulseSqlAssistant({
      base: { id: "Base01", name: "Shop" },
      sql: "SELECT :from, :to",
      params: { from: "2026-10-01", to: "2026-10-20" },
      locale,
    });
    expect(calls[0]?.body).toMatchObject({
      title: `${title} · Shop`,
      draft: { content: [{ type: "text", text: expect.stringContaining("from = 2026-10-01\nto = 2026-10-20") }, { type: "resource" }] },
    });
    await launchPulseSqlAssistant({ base: { id: "Base01", name: "Shop" }, sql: "", params: {}, queryName: "Old query", locale });
    expect(calls[1]?.body).toMatchObject({ title: `${title} · Shop` });
  }
});
test("keeps SQL fence content intact and surfaces launch failure without sending a turn", async () => {
  const calls = capture();
  await launchPulseSqlAssistant({ base: { id: "Base01", name: "Shop" }, sql: "SELECT '```'", params: {}, locale: "en" });
  expect(calls[0]?.body).toMatchObject({
    draft: { content: [{ text: "Help me with this Pulse query.\n\n````sql\nSELECT '```'\n````" }, { type: "resource" }] },
  });
  globalThis.fetch = Object.assign(async () => Response.json({ message: "offline" }, { status: 503 }), {
    preconnect: originalFetch.preconnect,
  });
  await expect(launchPulseSqlAssistant({ base: { id: "Base01", name: "Shop" }, sql: "SELECT 1", params: {} })).rejects.toThrow("offline");
});
