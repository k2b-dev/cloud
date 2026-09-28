import { describe, expect, test } from "bun:test";
import { accentForeground, contrastRatio } from "./accent";

const hex = (red: number, green: number, blue: number) =>
  `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

describe("Venue accent foreground", () => {
  test("keeps white on the default blue and switches to black on a light yellow", () => {
    expect(accentForeground("#2563eb")).toBe("#ffffff");
    expect(accentForeground("#facc15")).toBe("#000000");
    // The value the UX review measured for white on #facc15.
    expect(contrastRatio("#ffffff", "#facc15")).toBeLessThan(1.6);
  });

  test("reaches WCAG AA (4.5:1) on every accent an admin can pick", () => {
    let lowest = Number.POSITIVE_INFINITY;
    for (let red = 0; red <= 255; red += 17) {
      for (let green = 0; green <= 255; green += 17) {
        for (let blue = 0; blue <= 255; blue += 17) {
          const accent = hex(red, green, blue);
          lowest = Math.min(lowest, contrastRatio(accent, accentForeground(accent)));
        }
      }
    }
    for (let gray = 0; gray <= 255; gray += 1) {
      const accent = hex(gray, gray, gray);
      lowest = Math.min(lowest, contrastRatio(accent, accentForeground(accent)));
    }
    expect(lowest).toBeGreaterThanOrEqual(4.5);
  });
});
