import { afterEach, expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { maintenanceNoticeMessages } from "./maintenance-notice-messages";

type Answer = () => Response;
const problem = (body: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ type: "about:blank", status: 503, ...body }), {
    status: 503,
    headers: { "Content-Type": "application/problem+json", "Retry-After": "30" },
  });
const maintenance = () => problem({ title: "Cloud is in maintenance", code: "maintenance" });
const restarting = (reason: "updating" | "unavailable") => () =>
  problem({ title: "App is unavailable", code: "app_unavailable", appId: "mail", reason });
const ok = () => Response.json({ items: ["Hallenbelegung im Dezember"] });

test("the notice speaks every language of its catalog", () => expect(maintenanceNoticeMessages.check()).toEqual([]));

if (isServer) test.skip("requires browser conditions", () => {});
else {
  const bootstrap = createDomTestHarness();
  const { toast } = await import("@k2b/ui");
  const { installMaintenanceNotice } = await import("./maintenance-notice");
  bootstrap.cleanup();

  let dom: DomTestHarness | undefined;
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    toast.dismissAll();
    dom?.cleanup();
  });

  /**
   * A page whose requests get the next answer of their path (`METHOD /path`), and whose status checks get `status`.
   * Checks never run on a timer here: the test asks for one with an `online` event, as when the device is back.
   */
  const page = (answers: Record<string, Answer[]>, options: { bypass?: boolean; canEnd?: boolean } = {}) => {
    dom = createDomTestHarness();
    const calls: string[] = [];
    const state = { status: { maintenance: { active: true, until: null } } as Record<string, unknown> };
    const transport = window.fetch;
    window.fetch = Object.assign(async (input: Parameters<typeof window.fetch>[0], init?: Parameters<typeof window.fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
      calls.push(`${key}${url.search}`);
      if (url.pathname === "/_cloud/gateway/status") return Response.json(state.status);
      const answer = answers[key]?.shift();
      if (!answer) throw new Error(`No answer left for ${key}`);
      return answer();
    }, transport);
    dispose = installMaintenanceNotice({
      locale: () => "de",
      appName: (appId) => (appId === "mail" ? "Mail" : undefined),
      delay: () => 3_600_000,
      ...options,
    });
    const check = async () => {
      window.dispatchEvent(new window.Event("online"));
      await Bun.sleep(5);
    };
    return { calls, state, check };
  };

  const notices = () =>
    [...document.querySelectorAll<HTMLElement>("[data-k2b-toast]:not([data-closing])")].map((element) => element.textContent ?? "");

  test("a read during maintenance waits quietly, the notice says why, and the read runs again once it is over", async () => {
    const { calls, state, check } = page({ "GET /api/mail/threads": [maintenance, ok] });
    let settled = false;
    const read = window.fetch("/api/mail/threads").then((response) => {
      settled = true;
      return response;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain("Wartungsmodus aktiv");
    expect(notices()[0]).toContain("Deine Eingaben bleiben hier. Speichern und Senden ist nach der Wartung möglich.");

    // Still on: the read keeps waiting and nothing else is sent.
    await check();
    expect(settled).toBe(false);
    expect(calls).toEqual(["GET /api/mail/threads", "GET /_cloud/gateway/status"]);

    state.status = { maintenance: null };
    await check();
    const response = await read;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: ["Hallenbelegung im Dezember"] });
    expect(calls).toEqual(["GET /api/mail/threads", "GET /_cloud/gateway/status", "GET /_cloud/gateway/status", "GET /api/mail/threads"]);
    // The same toast now says that it is over; the page did not reload.
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain("Wartung beendet");
    expect(notices()[0]).toContain("Du kannst jetzt wieder speichern und senden.");
  });

  test("an action is blocked with its reason and never sent again on its own", async () => {
    const { calls, state, check } = page({ "POST /api/mail/send": [maintenance] });
    const response = await window.fetch("/api/mail/send", { method: "POST", body: JSON.stringify({ draftId: "d1" }) });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.json()).toMatchObject({
      code: "maintenance",
      message: "Wartungsmodus aktiv. Das geht wieder, sobald die Wartung beendet ist.",
    });
    expect(notices()[0]).toContain("Wartungsmodus aktiv");

    state.status = { maintenance: null };
    await check();
    expect(notices()[0]).toContain("Wartung beendet");
    // The person presses again; nothing ran by itself.
    expect(calls).toEqual(["POST /api/mail/send", "GET /_cloud/gateway/status"]);
  });

  test("one app restarting: its name, its own status check, and the end of the update", async () => {
    const { calls, state, check } = page({
      "GET /api/mail/threads": [restarting("updating"), ok],
      "DELETE /api/mail/threads/t1": [restarting("updating")],
    });
    const read = window.fetch("/api/mail/threads");
    await Bun.sleep(5);
    expect(notices()[0]).toContain("Mail wird gerade aktualisiert");
    expect(notices()[0]).toContain("Speichern und Senden ist nach der Aktualisierung möglich.");
    const removed = await window.fetch("/api/mail/threads/t1", { method: "DELETE" });
    expect(await removed.json()).toMatchObject({
      code: "app_unavailable",
      appId: "mail",
      message: "Mail wird gerade aktualisiert. Das geht wieder, sobald die Aktualisierung abgeschlossen ist.",
    });

    // The rest of the Cloud runs; the app is still away.
    state.status = { maintenance: null, app: { available: false } };
    await check();
    expect(notices()[0]).toContain("Mail wird gerade aktualisiert");
    state.status = { maintenance: null, app: { available: true } };
    await check();
    expect((await read).status).toBe(200);
    expect(notices()[0]).toContain("Aktualisierung abgeschlossen");
    expect(calls).toEqual([
      "GET /api/mail/threads",
      "DELETE /api/mail/threads/t1",
      "GET /_cloud/gateway/status?app=mail",
      "GET /_cloud/gateway/status?app=mail",
      "GET /api/mail/threads",
    ]);
  });

  test("an app that is simply away is not called updating", async () => {
    const { state, check } = page({ "GET /api/mail/threads": [restarting("unavailable"), ok] });
    const read = window.fetch("/api/mail/threads");
    await Bun.sleep(5);
    expect(notices()[0]).toContain("Mail ist gerade nicht erreichbar");
    expect(notices()[0]).toContain("sobald Mail verfügbar ist.");
    state.status = { maintenance: null, app: { available: true } };
    await check();
    await read;
    expect(notices()[0]).toContain("Mail ist verfügbar");
  });

  test("a waiting read ends with its own abort", async () => {
    page({ "GET /api/mail/threads": [maintenance] });
    const controller = new AbortController();
    const read = window.fetch("/api/mail/threads", { signal: controller.signal });
    await Bun.sleep(5);
    controller.abort(new DOMException("Left the page", "AbortError"));
    await expect(read).rejects.toThrow("Left the page");
  });

  test("pages, other origins and other errors pass unchanged", async () => {
    const html = () => new Response("<!doctype html><title>Wartung</title>", { status: 503, headers: { "Content-Type": "text/html" } });
    const failed = () => Response.json({ message: "Kaputt" }, { status: 500 });
    const { calls } = page({ "GET /app/mail/vorstand": [html], "POST /api/mail/send": [failed] });
    // A page swap gets the gateway's page and falls back to loading it as a document.
    expect((await window.fetch("/app/mail/vorstand", { headers: { Accept: "text/html" } })).status).toBe(503);
    expect((await window.fetch("/api/mail/send", { method: "POST" })).status).toBe(500);
    await expect(window.fetch("https://other.example/api")).rejects.toThrow("No answer left");
    expect(notices()).toEqual([]);
    expect(calls).toEqual(["GET /app/mail/vorstand", "POST /api/mail/send", "GET /api"]);
  });

  test("a bypassed administrator sees that only they see the Cloud, nothing is blocked, and can end it", async () => {
    const { calls, state } = page(
      { "GET /api/mail/threads": [ok], "POST /api/admin/maintenance/off": [() => new Response("no", { status: 500 }), ok] },
      { bypass: true, canEnd: true },
    );
    state.status = { maintenance: { active: true, until: null, bypass: true } };
    expect(notices()[0]).toContain("Wartungsmodus aktiv");
    expect(notices()[0]).toContain("Nur du siehst die Cloud.");
    expect((await window.fetch("/api/mail/threads")).status).toBe(200);

    const end = () => document.querySelector<HTMLButtonElement>("[data-k2b-toast] .k2b-toast__action");
    expect(end()?.textContent).toBe("Wartung beenden");
    end()?.click();
    await Bun.sleep(5);
    expect(notices()[0]).toContain("Die Wartung läuft noch. Versuch es noch einmal.");
    end()?.click();
    await Bun.sleep(5);
    expect(notices()[0]).toContain("Wartung beendet");
    expect(notices()[0]).toContain("Alle sehen die Cloud wieder.");
    expect(calls).toEqual(["GET /api/mail/threads", "POST /api/admin/maintenance/off", "POST /api/admin/maintenance/off"]);
  });

  test("a bypass without the admin role offers no way to end it; the end of maintenance shows", async () => {
    const { state, check } = page({}, { bypass: true });
    expect(notices()[0]).toContain("Nur du siehst die Cloud.");
    expect(document.querySelector("[data-k2b-toast] .k2b-toast__action")).toBeNull();
    state.status = { maintenance: null };
    await check();
    expect(notices()[0]).toContain("Wartung beendet");
  });

  test("dispose gives the page its own fetch back", () => {
    page({});
    const wrapped = window.fetch;
    dispose?.();
    dispose = undefined;
    expect(window.fetch).not.toBe(wrapped);
  });
}
