import { afterAll, afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAppMeta, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { announcements } from "@k2b/cloud/services/announcements";
import { session } from "@k2b/cloud/services/session";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { OverviewView, OverviewWork } from "../overview-contracts";
import * as overview from "../service/overview";
import * as pwaTask from "./task";

const root = mkdtempSync(join(tmpdir(), "spaces-pwa-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { pwaRoutes } = await import("./index");
const { app } = await import("../config");
const { overviewMessages } = await import("../frontend/overview-messages");
const { myTasksMessages } = await import("./messages");

/** Invented demo account. */
const person: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mmuster",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia.muster@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const guest: User = { ...person, id: "22222222-2222-4222-8222-222222222222", uid: "gast", profile: "guest", roles: ["guest"] };
const shell: RuntimeAppMeta = { id: "pwa", name: "Mobile app", icon: "ti ti-device-mobile", description: "", routes: ["/pwa"] };

setSystemTime(new Date("2026-10-24T12:00:00Z"));
const today = new Date("2026-10-24T12:00:00Z");
const at = (hours: number) => {
  const date = new Date(today);
  date.setUTCHours(hours, 0, 0, 0);
  return date.toISOString();
};
const item = (shortId: string, title: string, extra: Partial<OverviewWork["items"][number]> = {}): OverviewWork["items"][number] => ({
  shortId,
  spaceShortId: "Space1",
  spaceName: "Summer fair",
  spaceColor: "#16a34a",
  title,
  priority: null,
  startsAt: null,
  endsAt: null,
  deadline: null,
  deadlineAllDay: false,
  ...extra,
});
const counts = { mine: 2, today: 2, upcoming: 4 };
let work: Record<OverviewView, OverviewWork["items"]> = {
  mine: [item("Item01", "Order the tents", { deadline: "2026-01-02T09:00:00.000Z" }), item("Item02", "Write the flyer")],
  today: [item("Item03", "Set-up meeting", { startsAt: at(9), endsAt: at(10) }), item("Item04", "Call the bakery", { deadline: at(23) })],
  upcoming: [],
};

const task: pwaTask.PwaTask = {
  shortId: "Item01",
  spaceShortId: "Space1",
  spaceName: "Summer fair",
  spaceColor: "#16a34a",
  title: "Order the tents",
  event: false,
  completed: false,
  deadline: "2026-01-02T09:00:00.000Z",
  deadlineAllDay: false,
  startsAt: null,
  endsAt: null,
  allDay: false,
  location: null,
  people: [{ id: person.id, kind: "user", displayName: "Mia Muster", avatarHash: null }],
  description: "Two **large** tents.",
  checklist: [
    { id: "Check1", label: "Ask the rental", completed: true },
    { id: "Check2", label: "Pay the deposit", completed: false },
  ],
  canWrite: false,
};
const taskSpy = spyOn(pwaTask, "loadPwaTask").mockImplementation(async ({ taskShortId }) => (taskShortId === task.shortId ? task : null));
const loadSpy = spyOn(overview, "loadOverviewWork").mockImplementation(async ({ view }) => ({ view, counts, items: work[view] }));
const tokenSpy = spyOn(session, "getToken").mockReturnValue(null);
const sessionSpy = spyOn(session, "authenticateRequest").mockResolvedValue(null);
const spies = [
  taskSpy,
  loadSpy,
  tokenSpy,
  sessionSpy,
  stubRailSnapshot(),
  spyOn(announcements.active, "forState").mockResolvedValue({ banners: [], announcements: [], latestAnnouncementVersion: 0 }),
];
afterEach(() => {
  loadSpy.mockClear();
  tokenSpy.mockReturnValue(null);
  sessionSpy.mockResolvedValue(null);
});
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  setSystemTime();
});

const signIn = (kind: "app" | "web", account: User = person) => {
  tokenSpy.mockReturnValue("test-session");
  sessionSpy.mockResolvedValue({
    user: account,
    data: { userId: account.id, sid: "test", authEpoch: 0, kind, expiresAt: "2099-01-01T00:00:00Z" },
  });
};

const server = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps: [shell, app.meta] } as never);
    c.set("settings" as never, { app: { name: "Example Cloud" } } as never);
    await next();
  })
  .route("/pwa/spaces", pwaRoutes);

/** Only for parsing the HTML: the SSR render itself runs without browser globals. */
const parser = (() => {
  const dom = createDomTestHarness();
  dom.cleanup();
  return new dom.window.DOMParser();
})();

const render = async (path: string, headers: Record<string, string> = {}) => {
  const response = await server.request(`https://cloud.example.test${path}`, {
    headers: { Cookie: "pwa_session=test-session", ...headers },
  });
  const html = await response.text();
  return { response, document: parser.parseFromString(html, "text/html") as unknown as Document };
};

const rows = (document: Document) =>
  [...document.querySelectorAll(".spaces-pwa__row")].map((row) => ({
    title: row.querySelector(".spaces-pwa__title")?.textContent,
    space: row.querySelector(".spaces-pwa__space")?.textContent,
    check: row.querySelector("button.spaces-pwa__check")?.getAttribute("aria-label") ?? null,
    when: row.querySelector("time")?.textContent ?? null,
  }));

describe("Spaces in the mobile app", () => {
  test("declares its part for people with the user role, at the route the gateway sends to Spaces", () => {
    expect(app.meta.pwa).toEqual({ href: "/pwa/spaces", requiresRoles: ["user"], summary: "/api/spaces/overview/summary" });
    expect(app.meta.routes).toContain("/pwa/spaces");
  });

  test("lists the person's tasks with a check button each, in the app's frame with Spaces as the open tab", async () => {
    signIn("app");
    const { response, document } = await render("/pwa/spaces");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(loadSpy.mock.calls[0]?.[0]).toMatchObject({ userId: person.id, view: "mine" });
    expect(document.querySelector("h1.k2b-mobile-shell__title")?.textContent).toBe("Spaces");
    expect(document.querySelector('link[rel="manifest"]')).not.toBeNull();
    expect(document.querySelector('.k2b-tab-bar a[aria-current="page"]')?.getAttribute("href")).toBe("/pwa/spaces");
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("For me 2");
    expect(rows(document)).toEqual([
      { title: "Order the tents", space: "Summer fair", check: "Mark “Order the tents” as done", when: "Fri, Jan 2, 09:00" },
      { title: "Write the flyer", space: "Summer fair", check: "Mark “Write the flyer” as done", when: null },
    ]);
    expect(document.querySelector(".spaces-pwa__when")?.hasAttribute("data-overdue")).toBe(true);
    // A tap before the island runs would do nothing, so the buttons do not look ready until then.
    expect([...document.querySelectorAll<HTMLButtonElement>("button.spaces-pwa__check")].map((button) => button.disabled)).toEqual([
      true,
      true,
    ]);
  });

  test("shows today's events with their time range and without a check button", async () => {
    signIn("app");
    const { document } = await render("/pwa/spaces?view=today");
    expect(loadSpy.mock.calls[0]?.[0]).toMatchObject({ view: "today" });
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("Today 2");
    expect(rows(document)).toEqual([
      { title: "Set-up meeting", space: "Summer fair", check: null, when: "09:00–10:00" },
      { title: "Call the bakery", space: "Summer fair", check: "Mark “Call the bakery” as done", when: "Sat, Oct 24, 23:00" },
    ]);
    expect(document.querySelector(".spaces-pwa__event")?.getAttribute("aria-label")).toBe("Event");
  });

  test("falls back to the person's own tasks for an unknown view", async () => {
    signIn("app");
    await render("/pwa/spaces?view=everything");
    expect(loadSpy.mock.calls[0]?.[0]).toMatchObject({ view: "mine" });
  });

  for (const [locale, view, title] of [
    ["en", "mine", "Nothing assigned to you"],
    ["en", "today", "Nothing due today"],
    ["en", "upcoming", "No upcoming work"],
    ["de", "mine", "Dir ist nichts zugewiesen"],
    ["de", "upcoming", "Keine anstehenden Aufgaben oder Termine"],
  ] as const)
    test(`shows a calm empty state for ${view} (${locale})`, async () => {
      signIn("app");
      const saved = work;
      work = { mine: [], today: [], upcoming: [] };
      try {
        const { document } = await render(`/pwa/spaces?view=${view}`, { "Accept-Language": locale });
        const placeholder = document.querySelector(".spaces-pwa .k2b-placeholder");
        expect(placeholder?.textContent).toContain(title);
        expect(placeholder?.textContent).toContain(locale === "de" ? "Alles erledigt." : "You are all caught up.");
        expect(document.querySelector(".spaces-pwa__list")).toBeNull();
      } finally {
        work = saved;
      }
    });

  test("speaks German with a German request", async () => {
    signIn("app");
    const { document } = await render("/pwa/spaces", { "Accept-Language": "de" });
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("Für mich 2");
    expect(rows(document)[0]?.check).toBe("„Order the tents“ als erledigt markieren");
  });

  test("answers a guest's app session with the app's 403 page and reads no work", async () => {
    signIn("app", guest);
    const { response, document } = await render("/pwa/spaces");
    expect(response.status).toBe(403);
    expect(document.querySelector('link[rel="manifest"]')).not.toBeNull();
    expect(document.querySelector(".spaces-pwa")).toBeNull();
    expect(loadSpy).not.toHaveBeenCalled();
  });

  test("never renders the part for a web session or without a session", async () => {
    signIn("web");
    for (const cookie of ["session_token=test-session", ""]) {
      const response = await server.request("https://cloud.example.test/pwa/spaces?view=today", { headers: { Cookie: cookie } });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/pwa/_auth/session/launch?to=${encodeURIComponent("/pwa/spaces?view=today")}`);
    }
    expect(loadSpy).not.toHaveBeenCalled();
  });

  test("opens a task beside the list at its own address, with what the reader may not change and why", async () => {
    signIn("app");
    const { response, document } = await render("/pwa/spaces/Space1/Item01?view=today");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(taskSpy.mock.calls.at(-1)?.[0]).toMatchObject({ spaceShortId: "Space1", taskShortId: "Item01" });
    // The list keeps the view the address names; the task is the deepest level, so a phone shows it with a way back.
    expect(loadSpy.mock.calls.at(-1)?.[0]).toMatchObject({ view: "today" });
    expect(document.querySelector("title")?.textContent).toBe("Order the tents");
    const levels = [...document.querySelectorAll("[data-workspace-level]")];
    expect(levels.map((level) => level.getAttribute("data-workspace-level-shown"))).toEqual(["2 3", "1 2 3"]);
    expect(levels[1]?.querySelector(".k2b-app-workspace__level-back")?.getAttribute("href")).toBe("/pwa/spaces?view=today");
    expect(levels[1]?.querySelector("h2")?.textContent).toBe("Summer fair");
    const detail = document.querySelector(".spaces-pwa-task")!;
    expect(detail.querySelector("h3")?.textContent).toBe("Order the tents");
    expect(detail.querySelector(".spaces-pwa-task__note")?.textContent).toBe("Read only. You cannot change tasks in “Summer fair”.");
    expect(detail.querySelector("button.spaces-pwa__check")?.hasAttribute("disabled")).toBe(true);
    expect(detail.querySelector("strong")?.textContent).toBe("large");
    expect(
      [...detail.querySelectorAll(".spaces-pwa-task__checklist input")].map((input) => [
        input.hasAttribute("checked"),
        input.hasAttribute("disabled"),
      ]),
    ).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(detail.querySelector(".spaces-pwa-task__aside")?.textContent).toBe("1 of 2");
    expect(detail.querySelector('a[href="/app/spaces/Space1?item=Item01"]')?.textContent).toContain("Open in Spaces");
  });

  test("answers the task's address with JSON for the page's own reads, and a missing or unreadable task is not found", async () => {
    signIn("app");
    const json = await server.request("https://cloud.example.test/pwa/spaces/Space1/Item01", {
      headers: { Cookie: "pwa_session=test-session", Accept: "application/json" },
    });
    expect(json.status).toBe(200);
    expect(json.headers.get("vary")).toContain("Accept");
    expect(await json.json()).toEqual(task);
    // A browser's own preference for HTML, or JSON excluded, gets the page.
    for (const accept of ["text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "text/html, application/json;q=0"]) {
      const page = await server.request("https://cloud.example.test/pwa/spaces/Space1/Item01", {
        headers: { Cookie: "pwa_session=test-session", Accept: accept },
      });
      expect(page.headers.get("content-type")).toContain("text/html");
    }
    for (const accept of ["application/json", "text/html"]) {
      const missing = await server.request("https://cloud.example.test/pwa/spaces/Space1/Other1", {
        headers: { Cookie: "pwa_session=test-session", Accept: accept },
      });
      expect(missing.status).toBe(404);
      expect(await missing.text()).not.toContain("Order the tents");
    }
  });

  test("without a selection the list stands alone, and a wide screen holds the task's place", async () => {
    signIn("app", person);
    const { document } = await render("/pwa/spaces", { "Accept-Language": "de" });
    const levels = [...document.querySelectorAll("[data-workspace-level]")];
    expect(levels.map((level) => level.getAttribute("data-workspace-level-shown"))).toEqual(["1 2 3", "2 3"]);
    expect(levels[1]?.textContent).toContain("Keine Aufgabe ausgewählt");
    expect(document.querySelector(".spaces-pwa__copy")?.getAttribute("href")).toBe("/pwa/spaces/Space1/Item01");
  });

  test("keeps its catalog complete in every language", () => {
    expect(myTasksMessages.check()).toEqual([]);
    // The line on the Cloud app's Start counts the tasks for you and adds today's only when there are some.
    const en = myTasksMessages.resolve(["en"]).t;
    const de = myTasksMessages.resolve(["de"]).t;
    expect([en.summary({ mine: 0, today: 0 }), en.summary({ mine: 1, today: 0 }), en.summary({ mine: 5, today: 1 })]).toEqual([
      "No tasks for you",
      "1 task for you",
      "5 tasks for you · 1 today",
    ]);
    expect([de.summary({ mine: 0, today: 2 }), de.summary({ mine: 1, today: 0 }), de.summary({ mine: 5, today: 1 })]).toEqual([
      "Keine Aufgaben für dich · 2 heute",
      "1 Aufgabe für dich",
      "5 Aufgaben für dich · 1 heute",
    ]);
    expect(overviewMessages.check()).toEqual([]);
  });
});
