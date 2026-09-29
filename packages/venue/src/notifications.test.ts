import { describe, expect, test } from "bun:test";
import { resolveNotificationDefinitionPresentation } from "@k2b/cloud/contracts/notifications";
import { app } from "./config";
import { NOTIFICATIONS } from "./notifications";

// Invented demo data: Tuesday, September 29 and Wednesday, September 30, 2026 in Berlin summer time.
const shift = {
  venueId: "Ven001",
  venueName: "Harbor Cafe",
  timezone: "Europe/Berlin",
  shiftTitle: "Evening bar",
  startsAt: "2026-09-30T16:00:00.000Z",
  endsAt: "2026-09-30T20:00:00.000Z",
};

describe("Venue notification definitions", () => {
  test("register in defineApp with browser and email recommended, and English and German labels", () => {
    expect(Object.keys(app.notifications).sort()).toEqual(["shiftCancelled", "shiftReminder", "shiftUnderstaffed"]);
    expect(app.notifications.shiftReminder.id).toBe("venue.shiftReminder");
    expect(app.notifications.shiftCancelled.id).toBe("venue.shiftCancelled");
    expect(app.notifications.shiftUnderstaffed.id).toBe("venue.shiftUnderstaffed");
    const labels = Object.values(app.notifications).map((definition) => {
      expect(definition.recipient).toBe("user");
      expect(definition.delivery).toEqual({ recommended: ["browser", "email"], required: [] });
      return [
        resolveNotificationDefinitionPresentation(definition, "en").label,
        resolveNotificationDefinitionPresentation(definition, "de-DE").label,
      ];
    });
    expect(labels).toEqual([
      ["Shift reminders", "Schicht-Erinnerungen"],
      ["Shift cancellations", "Schicht-Absagen"],
      ["Understaffed shifts", "Unterbesetzte Schichten"],
    ]);
  });
});

describe("Venue notification content", () => {
  test("a reminder names the shift and opens the person's sign-up in the schedule", async () => {
    const data = { ...shift, assignmentId: "Asg001" };
    expect(await NOTIFICATIONS.shiftReminder.render(data, { locale: "en" })).toEqual({
      title: "Your shift Wed 18:00 · Harbor Cafe",
      body: "Evening bar, Wed, Sep 30 · 18:00–22:00. If you can't make it, leave the shift in Venues so someone else can take it.",
      targetHref: "/app/venue/Ven001/shifts?cd=2026-09-30&shift=a:Asg001",
    });
    expect((await NOTIFICATIONS.shiftReminder.render({ ...data, shiftTitle: null }, { locale: "de" })).title).toBe(
      "Deine Schicht Mi., 18:00 · Harbor Cafe",
    );
  });

  test("a cancellation says who left or who removed them, and opens the slot", async () => {
    const data = { ...shift, templateId: "Tpl001", person: "Sam Lee", removedBy: null };
    expect(await NOTIFICATIONS.shiftCancelled.render(data, { locale: "en" })).toEqual({
      title: "Sam Lee left Wed 18:00 · Harbor Cafe",
      body: "Sam Lee left “Evening bar”, Wed, Sep 30 · 18:00–22:00. The spot is free again.",
      targetHref: "/app/venue/Ven001/shifts?cd=2026-09-30&shift=Tpl001:2026-09-30",
    });
    const removed = await NOTIFICATIONS.shiftCancelled.render({ ...data, removedBy: "Alex Kim" }, { locale: "de" });
    expect(removed.title).toBe("Sam Lee wurde entfernt: Mi., 18:00 · Harbor Cafe");
    expect(removed.body).toBe("Alex Kim hat Sam Lee aus „Evening bar“ entfernt, Mi., 30. Sept. · 18:00–22:00. Der Platz ist wieder frei.");
  });

  test("a cancelled free time opens the schedule on its day", async () => {
    const rendered = await NOTIFICATIONS.shiftCancelled.render(
      { ...shift, shiftTitle: null, templateId: null, person: "Sam Lee", removedBy: null },
      { locale: "en" },
    );
    expect(rendered.body).toBe("Sam Lee left “Free time”, Wed, Sep 30 · 18:00–22:00. The spot is free again.");
    expect(rendered.targetHref).toBe("/app/venue/Ven001/shifts?cd=2026-09-30");
  });

  test("a gap notice counts the missing people and says more when the gap keeps the venue closed", async () => {
    const data = { ...shift, templateId: "Tpl001", assignedCount: 1, minPeople: 3, maxPeople: 4, blocksOpening: false };
    expect(await NOTIFICATIONS.shiftUnderstaffed.render(data, { locale: "en" })).toEqual({
      title: "2 missing · Wed 18:00 · Harbor Cafe",
      body: "“Evening bar”, Wed, Sep 30 · 18:00–22:00: 1 of 3–4 staffed.",
      targetHref: "/app/venue/Ven001/shifts?cd=2026-09-30&shift=Tpl001:2026-09-30",
    });
    expect(await NOTIFICATIONS.shiftUnderstaffed.render({ ...data, blocksOpening: true, maxPeople: null }, { locale: "de" })).toEqual({
      title: "Bleibt ohne Besetzung zu: 2 fehlen · Mi., 18:00 · Harbor Cafe",
      body: "„Evening bar“, Mi., 30. Sept. · 18:00–22:00: 1 von 3 besetzt. Der Standort öffnet für diese Schicht erst, wenn sie besetzt ist.",
      targetHref: "/app/venue/Ven001/shifts?cd=2026-09-30&shift=Tpl001:2026-09-30",
    });
  });

  test("the schedule link uses the venue's day for a shift shortly after midnight", async () => {
    // 00:30 on October 1 in Berlin is still September 30 in UTC.
    const rendered = await NOTIFICATIONS.shiftReminder.render(
      { ...shift, startsAt: "2026-09-30T22:30:00.000Z", endsAt: "2026-10-01T02:00:00.000Z", assignmentId: "Asg001" },
      { locale: "en" },
    );
    expect(rendered.targetHref).toBe("/app/venue/Ven001/shifts?cd=2026-10-01&shift=a:Asg001");
    expect(rendered.title).toBe("Your shift Thu 00:30 · Harbor Cafe");
  });
});
