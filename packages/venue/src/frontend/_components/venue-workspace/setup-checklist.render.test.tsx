import { describe, expect, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { Venue, VenueDashboard } from "../../../contracts";
import "../../ssr-test-plugin";

const { ScheduleEmptyState, scheduleIsEmpty, setupSteps } = await import("./setup-checklist");

const timestamp = "2026-09-01T00:00:00.000Z";
const board = (permission: Venue["permission"], data: Partial<VenueDashboard> = {}, openMode: Venue["openMode"] = "combined") =>
  ({
    venue: { id: "Cafe01", name: "Corner Café", timezone: "Europe/Berlin", openMode, permission },
    openingRules: [],
    templates: [],
    slots: [],
    otherAssignments: [],
    ...data,
  }) as unknown as VenueDashboard;
const rule = {
  id: "Rule01",
  venueId: "Cafe01",
  weekday: 1,
  startTime: "09:00",
  endTime: "17:00",
  note: null,
  position: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const shift = {
  id: "Temp01",
  venueId: "Cafe01",
  weekday: 1,
  title: "Morning counter",
  startTime: "09:00",
  endTime: "12:00",
  minPeople: 1,
  maxPeople: null,
  requireTargetForOpening: false,
  active: false,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const entry = (principal: AccessEntry["principal"]): AccessEntry => ({
  id: crypto.randomUUID(),
  principal,
  permission: "write",
  createdAt: timestamp,
});
const me = entry({ type: "user", userId: "11111111-1111-4111-8111-111111111111" });
const colleague = entry({ type: "user", userId: "22222222-2222-4222-8222-222222222222" });

const render = (dashboard: VenueDashboard, accessEntries: AccessEntry[] = [me], locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(ScheduleEmptyState, {
          dashboard,
          accessEntries,
          userId: "11111111-1111-4111-8111-111111111111",
          onOpenSettings: () => {},
        });
      },
    }),
  );

describe("Venue setup checklist", () => {
  test("derives each step from what exists", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const done = (data: Partial<VenueDashboard>, entries: AccessEntry[], openMode?: Venue["openMode"]) =>
      Object.fromEntries(setupSteps(board("admin", data, openMode), entries, userId).map((step) => [step.id, step.done]));

    expect(done({}, [me])).toEqual({ hours: false, shifts: false, team: false });
    expect(done({ openingRules: [rule] }, [me, colleague])).toEqual({ hours: true, shifts: false, team: true });
    // Regular hours alone open a venue in regular mode, so shifts are no step there.
    expect(done({ openingRules: [rule] }, [me], "regular")).toEqual({ hours: true, team: false });
    // A paused shift still counts as set up; a group or everyone signed in counts as a team.
    expect(done({ templates: [shift] }, [me, entry({ type: "group", groupId: "33333333-3333-4333-8333-333333333333" })])).toEqual({
      hours: true,
      shifts: true,
      team: true,
    });
    expect(done({}, [me, entry({ type: "service_account", serviceAccountId: "44444444-4444-4444-8444-444444444444" })]).team).toBeFalse();
  });

  test("treats a schedule without active shifts and sign-ups as empty", () => {
    expect(scheduleIsEmpty(board("admin"))).toBeTrue();
    expect(scheduleIsEmpty(board("admin", { templates: [shift] }))).toBeTrue();
    expect(scheduleIsEmpty(board("admin", { templates: [{ ...shift, active: true }] }))).toBeFalse();
  });

  test("shows admins of a new venue the open steps with a way into the settings, stacked in one list", () => {
    const html = render(board("admin"));

    expect(html).toContain("Set up this venue");
    expect(html.match(/data-setup-step=/g)).toHaveLength(3);
    for (const action of ["Open schedule settings", "Add shifts", "Share venue"]) expect(html).toContain(action);
    expect(html).toContain("sm:flex-row");
    expect(render(board("admin"), [me], "de")).toContain("Standort einrichten");
  });

  test("disappears once every step is done, and staff only read that no shifts are planned", () => {
    const ready = board("admin", { openingRules: [rule] }, "regular");
    expect(render(ready, [me, colleague])).not.toContain("Set up this venue");
    expect(render(ready, [me, colleague])).toContain("No shifts are planned here yet.");

    const staffView = render(board("write"));
    expect(staffView).not.toContain("Set up this venue");
    expect(staffView).toContain("No shifts are planned here yet.");
    expect(render(board("read"), [], "de")).toContain("Hier sind noch keine Schichten geplant.");
  });
});
