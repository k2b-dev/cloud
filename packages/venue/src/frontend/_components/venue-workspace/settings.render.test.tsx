import { describe, expect, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { DateOverride, OpeningRule, ShiftTemplate, Venue, VenueDashboard } from "../../../contracts";
import "../../ssr-test-plugin";

const { SettingsDialog } = await import("./settings");

const timestamp = "2026-09-01T00:00:00.000Z";

const exception = (overrides: Partial<DateOverride>): DateOverride => ({
  id: "Exc001",
  venueId: "Cafe01",
  date: "2030-10-19",
  kind: "closed",
  startTime: null,
  endTime: null,
  note: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
});

const template = (overrides: Partial<ShiftTemplate>): ShiftTemplate => ({
  id: "Temp01",
  venueId: "Cafe01",
  weekday: 1,
  date: null,
  title: "Morning counter",
  startTime: "09:00",
  endTime: "12:00",
  minPeople: 1,
  maxPeople: 2,
  requireTargetForOpening: false,
  active: true,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
});

const dashboard = (permission: Venue["permission"], data: Partial<VenueDashboard> = {}): VenueDashboard => ({
  venue: {
    id: "Cafe01",
    slug: "corner-cafe",
    name: "Corner Café",
    icon: "ti ti-coffee",
    description: null,
    timezone: "Europe/Berlin",
    openMode: "combined",
    signupMode: "both",
    publicEnabled: true,
    feedbackEnabled: true,
    accentColor: "#2563eb",
    logoBase64: null,
    bannerBase64: null,
    permission,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  openingRules: [],
  overrides: [],
  templates: [],
  slots: [],
  otherAssignments: [],
  outlook: { startDate: "2026-09-28", endDate: "2026-10-04", missingPeople: 0, nextGap: null },
  assignments: [],
  myUpcomingShifts: [],
  myShiftCount: 0,
  sections: [],
  feedback: null,
  feedbackEntries: [],
  feedbackEntriesPage: { page: 1, pageSize: 50, total: 0 },
  ...data,
});

const render = (
  permission: Venue["permission"],
  options: { locale?: string; tab?: "general" | "access" | "schedule"; data?: Partial<VenueDashboard>; accessEntries?: AccessEntry[] } = {},
) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: options.locale ?? "en",
      get children() {
        return createComponent(SettingsDialog, {
          dashboard: dashboard(permission, options.data),
          accessEntries: options.accessEntries ?? [],
          apiKeys: [],
          initialTab: options.tab,
          close: () => {},
        });
      },
    }),
  );

describe("Venue settings: General", () => {
  test("gives admins the save footer", () => {
    expect(render("admin")).toContain("No unsaved changes");
  });

  test("holds the public page switch, sign-up, time zone, and opening logic", () => {
    const html = render("admin");
    for (const label of ["Public page on", "Sign-up", "Time zone", "Public opening logic", "Europe/Berlin", "Free time"]) {
      expect({ label, shown: html.includes(label) }).toEqual({ label, shown: true });
    }
    expect(render("admin", { locale: "de" })).toContain("Öffentliche Seite an");
  });

  test("has no Links tab: the calendar lives in My shifts and the page links in the Public page view", () => {
    const html = render("admin");
    for (const tab of ["General", "Access", "Schedule", "Danger zone"]) expect(html).toContain(`>${tab}<`);
    expect(html).not.toContain(">Links<");
    expect(html).not.toContain("Connections");
    expect(html).not.toContain("Subscribe to calendar");
  });
});

describe("Venue settings: Schedule", () => {
  test("saves every change at once, so the tab has no save bar", () => {
    const html = render("admin", { tab: "schedule" });

    expect(html).not.toContain("No unsaved changes");
    expect(html).not.toContain("Public opening logic");
  });

  test("names exceptions by weekday, date, and localized kind, and folds past ones away", () => {
    const overrides = [
      exception({ id: "Exc001", kind: "open", startTime: "18:00", endTime: "23:00", note: "Long night" }),
      exception({ id: "Exc002", date: "2020-03-03", note: "Staff outing" }),
    ];
    const html = render("admin", { tab: "schedule", data: { overrides } });

    expect(html).toContain("Opening-hour exceptions");
    expect(html).toContain("Sat, 10/19/2030");
    expect(html).toContain("Special opening 18:00–23:00 · Long night");
    expect(html).toContain("Past opening-hour exceptions (1)");
    expect(html).toContain("New opening-hour exception");
    expect(html).not.toMatch(/<details[^>]*open/);

    const german = render("admin", { locale: "de", tab: "schedule", data: { overrides } });
    expect(german).toContain("Sa., 19.10.2030");
    expect(german).toContain("Sonderöffnung 18:00–23:00 · Long night");
  });

  test("lists regular hours from Monday to Sunday, like the shifts below them", () => {
    const rule = (id: string, weekday: number): OpeningRule => ({
      id,
      venueId: "Cafe01",
      weekday,
      startTime: "10:00",
      endTime: "18:00",
      note: null,
      position: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const html = render("admin", { tab: "schedule", data: { openingRules: [rule("Rule00", 0), rule("Rule02", 2), rule("Rule01", 1)] } });
    const order = ["Monday", "Tuesday", "Sunday"].map((day) => html.indexOf(`>${day}<`));
    expect(order.every((index) => index >= 0)).toBeTrue();
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  test("gives row edit and delete the compact size @k2b/ui uses for collection actions", () => {
    const html = render("admin", { tab: "schedule", data: { templates: [template({})] } });
    const actions = html.match(/<button[^>]*aria-label="(?:Edit|Delete) shift"[^>]*>/g) ?? [];
    expect(actions).toHaveLength(2);
    for (const action of actions) expect(action).toContain('data-size="sm"');
  });

  test("groups shifts by weekday and marks paused ones", () => {
    const templates = [
      template({ id: "Temp01", weekday: 2, title: "Tuesday bar" }),
      template({ id: "Temp02", weekday: 1, title: "Monday bar", active: false }),
      template({ id: "Temp03", weekday: 1, title: "Monday lunch", startTime: "12:00", endTime: "14:00" }),
    ];
    const html = render("admin", { tab: "schedule", data: { templates } });

    const order = ["Monday", "Monday bar", "Monday lunch", "Tuesday", "Tuesday bar"].map((text) => html.indexOf(`>${text}<`));
    expect(order.every((index) => index >= 0)).toBeTrue();
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(html.match(/>Paused</g)).toHaveLength(1);
    expect(html.match(/role="switch"/g)).toHaveLength(3);
    expect(html).toContain("“Monday bar” is active");
  });

  test("lists upcoming one-off shifts by date apart from the weekday groups and leaves past ones to the schedule", () => {
    const templates = [
      template({ id: "Temp01", weekday: 1, title: "Monday bar" }),
      template({ id: "Temp02", weekday: 6, date: "2030-10-19", title: "Summer party", startTime: "18:00", endTime: "23:00" }),
      template({ id: "Temp03", weekday: 2, date: "2020-03-03", title: "Old event" }),
    ];
    const html = render("admin", { tab: "schedule", data: { templates } });

    const order = ["Monday", "Monday bar", "One-off shifts", "Summer party"].map((text) => html.indexOf(`>${text}<`));
    expect(order.every((index) => index >= 0)).toBeTrue();
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(html).toContain("Sat, 10/19/2030 · 18:00–23:00");
    expect(html).not.toContain(">Saturday<");
    expect(html).not.toContain("Old event");
  });
});

describe("Venue settings: Access", () => {
  const manager = (
    id: string,
    principal: AccessEntry["principal"],
    displayName: string,
    extra: Partial<AccessEntry> = {},
  ): AccessEntry => ({
    id,
    principal,
    permission: "admin",
    displayName,
    createdAt: timestamp,
    ...extra,
  });
  const person = manager("access-person", { type: "user", userId: "user-1" }, "Ada Lovelace");
  const agent = manager("access-agent", { type: "service_account", serviceAccountId: "agent-1" }, "Shift planner", {
    serviceAccountKind: "agent",
  });
  const apiKey = manager("access-key", { type: "service_account", serviceAccountId: "key-1" }, "Corner Café API keys", {
    serviceAccountKind: "resource_bound",
  });
  // The editor marks the only manager's remove button with the reason it cannot be removed.
  const lockedRows = (html: string) => html.match(/aria-description=/g)?.length ?? 0;

  test("shows an agent that manages the venue, so a person managing next to it is not locked", () => {
    const html = render("admin", { tab: "access", accessEntries: [person, agent, apiKey] });

    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Shift planner");
    expect(html).toContain("(Agent)");
    expect(lockedRows(html)).toBe(0);
  });

  test("keeps API keys in their own section and does not count them as managers", () => {
    const html = render("admin", { tab: "access", accessEntries: [person, apiKey] });

    expect(html).not.toContain("Corner Café API keys");
    expect(lockedRows(html)).toBe(1);
  });
});
