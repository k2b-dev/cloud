import { expect, test } from "bun:test";
import { formatRecordHistoryAction, formatRecordRelativeTime } from "./RecordHistorySection";

test("record history dates use the configured locale and timezone", () => {
  expect(formatRecordRelativeTime("2000-01-01T00:30:00.000Z", { locale: "en-US", timeZone: "America/New_York" })).toBe("12/31/1999");
});

test("record history exposes one canonical Document creation action", () => {
  expect(formatRecordHistoryAction("document.created")).toBe("Document created");
  expect(formatRecordHistoryAction("future.record.event")).toBe("future.record.event");
});
