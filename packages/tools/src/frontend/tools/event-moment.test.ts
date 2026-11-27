import { expect, test } from "bun:test";
import { parseEventMoment } from "./event-moment";

test("an event moment is read in the key order and in the German order", () => {
  expect(parseEventMoment("2026-06-15 14:30")).toBe("2026-06-15T14:30");
  expect(parseEventMoment("2026-06-15T09:05")).toBe("2026-06-15T09:05");
  expect(parseEventMoment("15.06.2026 14:30")).toBe("2026-06-15T14:30");
  expect(parseEventMoment("5.6.2026, 9:00")).toBe("2026-06-05T09:00");
});

test("text that is no real date and time is no moment", () => {
  for (const text of ["", "morgen", "15.06.2026", "31.06.2026 10:00", "2026-02-29 10:00", "15.06.2026 24:00", "2026-06-15 14:61"])
    expect(parseEventMoment(text)).toBeUndefined();
});
