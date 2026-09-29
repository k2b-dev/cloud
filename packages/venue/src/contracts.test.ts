// fallow-ignore-file unused-file
import { describe, expect, test } from "bun:test";
import {
  FeedbackEntrySchema,
  PublicSectionInputSchema,
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
});
