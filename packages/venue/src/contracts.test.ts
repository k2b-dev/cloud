// fallow-ignore-file unused-file
import { describe, expect, test } from "bun:test";
import {
  FeedbackEntrySchema,
  PublicExceptionSchema,
  PublicSectionInputSchema,
  PublicStatusSchema,
  publicLinkHref,
  ShiftTemplateInputSchema,
  UpcomingSlotSchema,
  VenueResourceIdSchema,
} from "./contracts";

describe("Venue public identities", () => {
  test("accepts only six-character public resource IDs", () => {
    expect(VenueResourceIdSchema.safeParse("Venu01").success).toBeTrue();
    expect(VenueResourceIdSchema.safeParse(crypto.randomUUID()).success).toBeFalse();
  });

  test("does not publish feedback row IDs or virtual occurrence keys", () => {
    expect(FeedbackEntrySchema.keyof().options).not.toContain("id");
    expect(UpcomingSlotSchema.keyof().options).not.toContain("key");
  });
});

describe("ShiftTemplateInputSchema", () => {
  const oneOff = { date: "2026-10-07", title: "Special event", startTime: "09:00", endTime: "13:00" };

  test("accepts a one-off date without a weekday and keeps the date", () => {
    expect(ShiftTemplateInputSchema.parse(oneOff).date).toBe(oneOff.date);
    expect(ShiftTemplateInputSchema.safeParse({ ...oneOff, weekday: 3 }).success).toBeTrue();
  });

  test("requires the weekday for weekly shifts and agreement for dated shifts", () => {
    expect(ShiftTemplateInputSchema.safeParse({ ...oneOff, weekday: 4 }).success).toBeFalse();
    expect(ShiftTemplateInputSchema.safeParse({ ...oneOff, date: null }).success).toBeFalse();
    const { date: _date, ...weekly } = oneOff;
    expect(ShiftTemplateInputSchema.safeParse(weekly).success).toBeFalse();
    expect(ShiftTemplateInputSchema.safeParse({ ...weekly, weekday: 3 }).success).toBeTrue();
    expect(ShiftTemplateInputSchema.safeParse({ ...weekly, date: null, weekday: 3 }).success).toBeTrue();
  });

  test("rejects invalid one-off dates", () => {
    for (const date of ["2026-02-30", "2026-13-01", "tomorrow"]) {
      expect(ShiftTemplateInputSchema.safeParse({ ...oneOff, date, weekday: 3 }).success).toBeFalse();
    }
  });

  test("accepts an optional max people value above the target", () => {
    expect(
      ShiftTemplateInputSchema.safeParse({
        weekday: 1,
        title: "Morning shift",
        startTime: "09:00",
        endTime: "13:00",
        minPeople: 2,
        maxPeople: 4,
        requireTargetForOpening: true,
        active: true,
      }).success,
    ).toBe(true);
  });

  test("rejects max people below the target", () => {
    const result = ShiftTemplateInputSchema.safeParse({
      weekday: 1,
      title: "Morning shift",
      startTime: "09:00",
      endTime: "13:00",
      minPeople: 4,
      maxPeople: 2,
      requireTargetForOpening: false,
      active: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("Maximum people must be greater than or equal to required people");
  });

  test("defaults to the backward-compatible first-signup opening policy", () => {
    const result = ShiftTemplateInputSchema.parse({
      weekday: 1,
      title: "Morning shift",
      startTime: "09:00",
      endTime: "13:00",
      minPeople: 2,
      maxPeople: null,
      active: true,
    });

    expect(result.requireTargetForOpening).toBe(false);
  });

  test("takes 24:00 as an end time for until midnight, and no clock time past it", () => {
    const shift = (startTime: string, endTime: string) =>
      ShiftTemplateInputSchema.safeParse({ weekday: 5, title: "Late bar", startTime, endTime, minPeople: 1 }).success;
    expect([shift("18:00", "24:00"), shift("24:00", "24:00"), shift("18:00", "24:30"), shift("18:00", "23:60")]).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  test("requires a positive target when target staffing controls opening", () => {
    const result = ShiftTemplateInputSchema.safeParse({
      weekday: 1,
      title: "Morning shift",
      startTime: "09:00",
      endTime: "13:00",
      minPeople: 0,
      maxPeople: null,
      requireTargetForOpening: true,
      active: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("Target people must be at least one when it controls public opening");
  });
});

describe("PublicSectionInputSchema", () => {
  const menu = (item: Record<string, unknown>) => ({
    kind: "menu",
    title: "Menu",
    content: { items: [{ name: "Lunch special", ...item }] },
    enabled: true,
    position: 1,
  });

  test("accepts optional menu availability dates", () => {
    expect(PublicSectionInputSchema.safeParse(menu({ availableFrom: "2026-07-13", availableUntil: "2026-07-15" })).success).toBe(true);
  });

  test("rejects reversed or malformed menu availability dates", () => {
    expect(PublicSectionInputSchema.safeParse(menu({ availableFrom: "2026-07-15", availableUntil: "2026-07-13" })).success).toBe(false);
    expect(PublicSectionInputSchema.safeParse(menu({ availableFrom: "tomorrow" })).success).toBe(false);
  });

  const links = (...hrefs: unknown[]) => ({
    kind: "links",
    title: "Useful links",
    content: { links: hrefs.map((href, index) => ({ label: `Link ${index + 1}`, href })) },
  });

  test("accepts only link addresses the public page shows", () => {
    const accepted = [
      "https://union.example.org/cafe",
      " http://example.org ",
      "mailto:cafe@example.org",
      "tel:+49301234567",
      "/app/grids/forms/Form01",
    ];
    expect(accepted.map((href) => [href, publicLinkHref(href) !== null])).toEqual(accepted.map((href) => [href, true]));
    expect(PublicSectionInputSchema.safeParse(links(...accepted)).success).toBe(true);
    // A links section without links shows its text.
    expect(PublicSectionInputSchema.safeParse({ kind: "links", title: "Links", content: { text: "Soon" } }).success).toBe(true);
  });

  test("rejects a link address the public page would leave out, and names the link", () => {
    for (const href of [
      "www.cafe.example.org",
      "example.org/menu",
      "javascript:alert(1)",
      "//other.example.org",
      "/\\other.example.org",
      "",
      42,
    ]) {
      const result = PublicSectionInputSchema.safeParse(links("https://example.org", href));
      expect({ href, success: result.success }).toEqual({ href, success: false });
      if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([["content", "links", 1, "href"]]);
    }
    expect(PublicSectionInputSchema.safeParse({ kind: "links", title: "Links", content: { links: "https://example.org" } }).success).toBe(
      false,
    );
  });
});

describe("PublicStatusSchema", () => {
  test("lists upcoming exceptions by date, kind, times, and note, without internal IDs", () => {
    expect(PublicStatusSchema.keyof().options).toContain("upcomingExceptions");
    expect(PublicExceptionSchema.keyof().options.toSorted()).toEqual(["date", "endTime", "kind", "note", "startTime"]);
    expect(
      PublicExceptionSchema.safeParse({ date: "2026-10-17", kind: "open", startTime: "18:00", endTime: "24:00", note: "Long night" })
        .success,
    ).toBeTrue();
    expect(
      PublicExceptionSchema.safeParse({ date: "2026-10-03", kind: "holiday", startTime: null, endTime: null, note: null }).success,
    ).toBeFalse();
  });
});
