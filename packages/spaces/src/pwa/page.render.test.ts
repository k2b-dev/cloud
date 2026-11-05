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
import * as pwaSpace from "./space";
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
  canWrite: true,
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
const entries: pwaSpace.PwaSpaceEntry[] = [
  { shortId: "Space1", name: "Summer fair", color: "#16a34a", openCount: 3, canWrite: true, pinned: true },
  { shortId: "Space2", name: "Archive", color: "#64748b", openCount: 0, canWrite: false, pinned: false },
];
const spaceRow = (shortId: string, title: string, extra: Partial<pwaSpace.PwaRow> = {}): pwaSpace.PwaRow => ({
  shortId,
  title,
  statusId: "Col001",
  completed: false,
  startsAt: null,
  endsAt: null,
  deadline: null,
  deadlineAllDay: true,
  overdue: false,
  blocked: false,
  checklist: null,
  tags: [],
  people: [],
  ...extra,
});
const fair: pwaSpace.PwaSpace = {
  shortId: "Space1",
  name: "Summer fair",
  color: "#16a34a",
  canWrite: true,
  statuses: [
    { id: "Col001", name: "Inbox", color: "#94a3b8", done: false },
    { id: "Col002", name: "Doing", color: "#2563eb", done: false },
    { id: "Col003", name: "Done", color: "#16a34a", done: true },
  ],
  tags: [{ id: "Tag001", name: "Supplier", color: "#0e7490" }],
  templates: [],
  filter: { mine: false, tagIds: [], search: "" },
  groups: [
    {
      statusId: "Col001",
      total: 2,
      pages: 1,
      totalPages: 1,
      rows: [
        spaceRow("Item01", "Order the tents", {
          tags: [{ id: "Tag001", name: "Supplier", color: "#0e7490" }],
          checklist: { done: 1, total: 2 },
        }),
        spaceRow("Item05", "Book the band", { blocked: true, deadline: "2026-10-20", overdue: true }),
      ],
    },
    { statusId: "Col002", total: 0, pages: 1, totalPages: 0, rows: [] },
    { statusId: "Col003", total: 7, pages: 0, totalPages: 1, rows: [] },
  ],
};
let readable: pwaSpace.PwaSpace | null = fair;
const entriesSpy = spyOn(pwaSpace, "loadPwaSpaceEntries").mockImplementation(async () => entries);
const spaceSpy = spyOn(pwaSpace, "loadPwaSpace").mockImplementation(async ({ spaceShortId, filter }) =>
  spaceShortId === "Space1" && readable ? { ...readable, filter } : null,
);
const pageSpy = spyOn(pwaSpace, "loadPwaGroupPage").mockImplementation(async ({ spaceShortId, statusId, page }) =>
  spaceShortId === "Space1" && statusId === "Col003"
    ? { statusId, total: 7, pages: page, totalPages: 1, rows: [spaceRow("Item09", "Print posters", { completed: true, statusId })] }
    : null,
);
const taskSpy = spyOn(pwaTask, "loadPwaTask").mockImplementation(async ({ taskShortId }) => (taskShortId === task.shortId ? task : null));
const loadSpy = spyOn(overview, "loadOverviewWork").mockImplementation(async ({ view }) => ({ view, counts, items: work[view] }));
const tokenSpy = spyOn(session, "getToken").mockReturnValue(null);
const sessionSpy = spyOn(session, "authenticateRequest").mockResolvedValue(null);
const spies = [
  entriesSpy,
  spaceSpy,
  pageSpy,
  taskSpy,
  loadSpy,
  tokenSpy,
  sessionSpy,
  stubRailSnapshot(),
  spyOn(announcements.active, "forState").mockResolvedValue({ banners: [], announcements: [], latestAnnouncementVersion: 0 }),
];
afterEach(() => {
  loadSpy.mockClear();
  spaceSpy.mockClear();
  readable = fair;
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

describe("Spaces in the Cloud app", () => {
  test("declares its part for people with the user role, at the route the gateway sends to Spaces", () => {
    expect(app.meta.pwa).toEqual({ href: "/pwa/spaces", requiresRoles: ["user"], summary: "/api/spaces/overview/summary", order: 3 });
    expect(app.meta.routes).toContain("/pwa/spaces");
  });

  test("lists the person's tasks with a check button each, in the app's frame with Spaces as the open tab", async () => {
    signIn("app");
    const { response, document } = await render("/pwa/spaces");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, no-transform");
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
    expect(response.headers.get("cache-control")).toBe("private, no-store, no-transform");
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

  test("the list's title switches between My tasks and every Space, and says so before the island runs", async () => {
    signIn("app");
    const { document } = await render("/pwa/spaces");
    const title = document.querySelector('[data-workspace-main-region="list"] h2 button');
    expect(title?.getAttribute("aria-haspopup")).toBe("menu");
    expect(title?.getAttribute("aria-label")).toBe("My tasks, Switch Space");
    expect(document.querySelector('[data-workspace-main-region="list"] [role="menu"]')?.getAttribute("aria-label")).toBe("Switch Space");
    expect(document.querySelector('[data-workspace-main-region="list"] button[aria-label="Search tasks"]')).not.toBeNull();
  });

  test("without any Space, My tasks says how to get one and links to Spaces on the web", async () => {
    signIn("app");
    entriesSpy.mockImplementationOnce(async () => []);
    const { document } = await render("/pwa/spaces", { "Accept-Language": "de" });
    const placeholder = document.querySelector(".spaces-pwa-space__state .k2b-placeholder");
    expect(placeholder?.textContent).toContain("Du bist noch in keinem Space");
    expect(placeholder?.querySelector('a[href="/app/spaces"]')?.textContent).toContain("Spaces im Web öffnen");
    expect(document.querySelector(".spaces-pwa__list")).toBeNull();
  });

  test("a Space lists its statuses with their counts and rows, a done status folded, read with the address's filter", async () => {
    signIn("app");
    const { response, document } = await render("/pwa/spaces/Space1?mine=1&tag=Tag001");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private, no-store");
    expect(spaceSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      spaceShortId: "Space1",
      filter: { mine: true, tagIds: ["Tag001"], search: "" },
    });
    expect(document.querySelector("title")?.textContent).toBe("Summer fair");
    expect(document.querySelector('[data-workspace-main-region="list"] h2')?.textContent).toBe("Summer fair");
    const heads = [...document.querySelectorAll(".spaces-pwa-space__group-head")].map((head) => [
      head.textContent,
      head.getAttribute("aria-expanded"),
    ]);
    // With a filter, a status without a match steps aside; the done status keeps its folded count.
    expect(heads).toEqual([
      ["Inbox2", "true"],
      ["Done7", "false"],
    ]);
    const first = document.querySelector(".spaces-pwa-space__row")!;
    expect(first.querySelector(".spaces-pwa__title")?.textContent).toBe("Order the tents");
    expect(first.querySelector(".k2b-tag")?.textContent).toBe("Supplier");
    expect(first.querySelector('[aria-label="Checklist 1 of 2"]')?.textContent).toBe("1/2");
    const second = document.querySelectorAll(".spaces-pwa-space__row")[1]!;
    expect(second.querySelector(".spaces-pwa-space__blocked")?.textContent).toBe("Blocked");
    expect(second.querySelector("time")?.hasAttribute("data-overdue")).toBe(true);
    expect(document.querySelector('.spaces-pwa-space__filters [aria-pressed="true"]')?.textContent).toContain("Assigned to me");
    expect(document.querySelector(".spaces-pwa-space__row .spaces-pwa__copy")?.getAttribute("href")).toBe(
      "/pwa/spaces/Space1/Item01?list=space&mine=1&tag=Tag001",
    );
  });

  test("a read-only Space says so under its title and keeps its checks off", async () => {
    signIn("app");
    readable = { ...fair, canWrite: false };
    const { document } = await render("/pwa/spaces/Space1", { "Accept-Language": "de" });
    expect(document.querySelector(".spaces-pwa-space__note")?.textContent).toBe(
      "Nur lesen. Du kannst in „Summer fair“ keine Aufgaben ändern.",
    );
    expect(
      [...document.querySelectorAll<HTMLButtonElement>(".spaces-pwa-space__row button.spaces-pwa__check")].every(
        (button) => button.disabled,
      ),
    ).toBe(true);
  });

  test("a Space the reader may not read is not found, and its page names nothing", async () => {
    signIn("app");
    const { response, document } = await render("/pwa/spaces/Secret1");
    expect(response.status).toBe(404);
    const placeholder = document.querySelector(".spaces-pwa-space__state .k2b-placeholder");
    expect(placeholder?.textContent).toContain("This Space cannot be opened");
    expect(placeholder?.querySelector('a[href="/pwa/spaces"]')?.textContent).toContain("To My tasks");
  });

  test("answers a Space's address with JSON: the Space with the pages it names, one page of one status, or not found", async () => {
    signIn("app");
    const headers = { Cookie: "pwa_session=test-session", Accept: "application/json" };
    const snapshot = await server.request("https://cloud.example.test/pwa/spaces/Space1?q=tent&load=Col003:2", { headers });
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("vary")).toContain("Accept");
    expect(snapshot.headers.get("cache-control")).toContain("no-transform");
    expect(((await snapshot.json()) as pwaSpace.PwaSpace).filter).toEqual({ mine: false, tagIds: [], search: "tent" });
    expect(spaceSpy.mock.calls.at(-1)?.[0].load).toEqual(new Map([["Col003", 2]]));
    const page = await server.request("https://cloud.example.test/pwa/spaces/Space1?status=Col003&page=1", { headers });
    expect(((await page.json()) as pwaSpace.PwaGroup).rows.map((row) => row.title)).toEqual(["Print posters"]);
    for (const path of ["/pwa/spaces/Secret1", "/pwa/spaces/Space1?status=Other1&page=1"]) {
      const missing = await server.request(`https://cloud.example.test${path}`, { headers });
      expect(missing.status).toBe(404);
    }
  });

  test("a task beside its Space keeps the Space's list and filter, and its way back leads there", async () => {
    signIn("app");
    const { document } = await render("/pwa/spaces/Space1/Item01?list=space&tag=Tag001");
    expect(spaceSpy.mock.calls.at(-1)?.[0]).toMatchObject({ spaceShortId: "Space1", filter: { tagIds: ["Tag001"] } });
    const levels = [...document.querySelectorAll("[data-workspace-level]")];
    expect(levels[1]?.querySelector(".k2b-app-workspace__level-back")?.getAttribute("href")).toBe("/pwa/spaces/Space1?tag=Tag001");
    expect(levels[0]?.querySelector('.spaces-pwa-space__row[aria-current="true"] .spaces-pwa__title')?.textContent).toBe("Order the tents");
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
