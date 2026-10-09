import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Avatar } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceItemAssignee, SpaceTag } from "@/contracts";
import {
  CALENDAR_NEUTRAL_COLOR,
  CALENDAR_PRIORITY_COLORS,
  type CalendarColorSource,
  calendarItemColors,
  calendarPersonColor,
  isCalendarFlagged,
  isCalendarTask,
} from "./colors";

const columns = [
  { id: "Col001", color: "#22c55e" },
  { id: "Col002", color: null },
];
const tag = (id: string, color: string): SpaceTag => ({ id, spaceId: "Space1", name: id, color });
const person = (displayName: string): SpaceItemAssignee => ({ id: crypto.randomUUID(), displayName, avatarHash: null });
const item = (patch: Partial<CalendarColorSource> = {}): CalendarColorSource => ({
  tags: [],
  columnId: "Col001",
  priority: null,
  assignees: [],
  ...patch,
});

describe("calendar item colors", () => {
  test("by tag: the first tag, then the status color, then neutral, with further tags as extra dots", () => {
    expect(calendarItemColors(item({ tags: [tag("a", "#8b5cf6"), tag("b", "#ec4899"), tag("c", "#14b8a6")] }), "tag", columns)).toEqual({
      color: "#8b5cf6",
      extra: ["#ec4899", "#14b8a6"],
    });
    expect(calendarItemColors(item(), "tag", columns)).toEqual({ color: "#22c55e", extra: [] });
    expect(calendarItemColors(item({ columnId: "Col002" }), "tag", columns)).toEqual({ color: CALENDAR_NEUTRAL_COLOR, extra: [] });
    // A column this calendar does not know, for example after it was deleted in another tab.
    expect(calendarItemColors(item({ columnId: "Gone01", tags: undefined }), "tag", columns).color).toBe(CALENDAR_NEUTRAL_COLOR);
  });

  test("by status: the column color or neutral, whatever the tags", () => {
    expect(calendarItemColors(item({ tags: [tag("a", "#8b5cf6")] }), "status", columns)).toEqual({ color: "#22c55e", extra: [] });
    expect(calendarItemColors(item({ columnId: "Col002", tags: [tag("a", "#8b5cf6")] }), "status", columns)).toEqual({
      color: CALENDAR_NEUTRAL_COLOR,
      extra: [],
    });
  });

  test("by priority: the priority filter colors, neutral without a priority", () => {
    for (const priority of ["urgent", "high", "medium", "low"] as const) {
      expect(calendarItemColors(item({ priority }), "priority", columns)).toEqual({ color: CALENDAR_PRIORITY_COLORS[priority], extra: [] });
    }
    expect(calendarItemColors(item({ tags: [tag("a", "#8b5cf6")] }), "priority", columns).color).toBe(CALENDAR_NEUTRAL_COLOR);
  });

  test("by person: the first assignee's avatar color, further assignees as dots, unassigned neutral", () => {
    const robin = person("Robin Example");
    const kim = person("Kim Example");
    expect(calendarItemColors(item({ assignees: [robin, kim] }), "person", columns)).toEqual({
      color: calendarPersonColor("Robin Example"),
      extra: [calendarPersonColor("Kim Example")],
    });
    expect(calendarItemColors(item({ tags: [tag("a", "#8b5cf6")] }), "person", columns)).toEqual({
      color: CALENDAR_NEUTRAL_COLOR,
      extra: [],
    });
  });

  test("a person keeps the color of their avatar initials", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "../../../../../../ui/src/styles/surfaces-widgets-parity.css")).text();
    for (const name of ["Robin Example", "Kim Example", "  Alex Doe ", "Zoë"]) {
      const tint = /data-tint="(\d+)"/.exec(renderToString(() => createComponent(Avatar, { name })))?.[1];
      const hue = new RegExp(`\\[data-tint="${tint}"\\] \\{ --k2b-avatar-hue: (#[0-9a-f]{6}); \\}`).exec(css)?.[1];
      expect({ name, color: calendarPersonColor(name) }).toEqual({ name, color: hue! });
    }
  });

  test("tasks are dated items without a start; urgent and high priority carry the flag", () => {
    expect(isCalendarTask({ deadline: "2026-10-08T00:00:00.000Z", startsAt: null })).toBe(true);
    expect(isCalendarTask({ deadline: "2026-10-08T00:00:00.000Z", startsAt: "2026-10-08T09:00:00.000Z" })).toBe(false);
    expect(isCalendarTask({ deadline: null, startsAt: "2026-10-08T09:00:00.000Z" })).toBe(false);
    expect((["urgent", "high", "medium", "low", null] as const).map((priority) => isCalendarFlagged({ priority }))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

/** sRGB channels of a `#rrggbb` color. */
const rgb = (hex: string) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
/** `color-mix(in srgb, a share, b)`, which mixes the gamma-encoded channels. */
const mix = (a: number[], share: number, b: number[]) => a.map((channel, index) => channel * share + b[index]! * (1 - share));
const luminance = (channels: number[]) => {
  const [r, g, b] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: number[], b: number[]) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
};

describe("calendar color contrast", async () => {
  const tokens = await Bun.file(resolve(import.meta.dir, "../../../../../../ui/src/styles/index.css")).text();
  // The calendar's tokens: light theme first, the dark theme's in the later block.
  const token = (name: string, theme: 0 | 1) => [...tokens.matchAll(new RegExp(`--k2b-${name}: (#[0-9a-f]{6});`, "g"))][theme]![1]!;
  const themes = [0, 1].map((theme) => ({
    name: theme === 0 ? "light" : "dark",
    text: rgb(token(theme === 0 ? "neutral-950" : "neutral-50", 0)),
    surface: rgb(token("surface", theme as 0 | 1)),
    elevated: rgb(token("surface-elevated", theme as 0 | 1)),
  }));
  // Every color the helper returns by itself, and the extremes a tag's free color picker allows.
  const colors = [
    CALENDAR_NEUTRAL_COLOR,
    ...Object.values(CALENDAR_PRIORITY_COLORS),
    ...["Robin", "Kim", "Alex", "Sam", "Jo", "Mia", "Ben", "Lea", "Tom", "Eva", "Max", "Ida"].map(calendarPersonColor),
    "#6b7280",
    "#0ea5e9",
    "#ffffff",
    "#000000",
    "#ffff00",
  ];

  test("an item's title stays readable on its tinted fill in both themes", () => {
    for (const theme of themes) {
      for (const color of colors) {
        // The @k2b/ui event fill: 12 % of the item color on the elevated surface, 17 % when selected or hovered.
        for (const share of [0.12, 0.17]) {
          const fill = mix(rgb(color), share, theme.elevated);
          expect({ theme: theme.name, color, share, readable: contrast(theme.text, fill) >= 4.5 }).toEqual({
            theme: theme.name,
            color,
            share,
            readable: true,
          });
        }
      }
    }
  });

  test("a task's checkbox stands out from the surface for every color the helper picks", () => {
    // Free tag colors may be as light as the surface; the title, not the checkbox, carries the item then.
    const picked = colors.slice(0, -3);
    for (const theme of themes) {
      for (const color of picked) {
        const icon = mix(rgb(color), 0.75, theme.text);
        expect({ theme: theme.name, color, visible: contrast(icon, theme.surface) >= 3 }).toEqual({
          theme: theme.name,
          color,
          visible: true,
        });
      }
    }
  });
});
