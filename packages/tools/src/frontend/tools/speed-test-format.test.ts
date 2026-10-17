import { expect, test } from "bun:test";
import { charts } from "@k2b/stdlib";
import type { ChartSelection } from "@k2b/ui";
import { formatSpeedTestReading, speedTestSparklineTooltip } from "./speed-test-format";

const unescape = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
/** The first sparkline sample the renderer marks for inspection, as the @k2b/ui Chart hands it to the tooltip. */
const firstSample = (data: number[]): ChartSelection => {
  const raw = charts.sparkline({ data, smooth: true, showLast: true, inspect: true }).match(/data-chart-datum="([^"]*)"/)?.[1];
  if (!raw) throw new Error("No inspectable sparkline sample");
  return { kind: "sparkline", datum: JSON.parse(unescape(raw)) };
};

test("the large reading keeps one decimal below 10 and whole numbers above, in the reader's locale", () => {
  expect(formatSpeedTestReading(null, "de")).toBe("—");
  expect(formatSpeedTestReading(9.46, "de")).toBe("9,5");
  expect(formatSpeedTestReading(9.46, "en")).toBe("9.5");
  expect(formatSpeedTestReading(94.123456, "de")).toBe("94");
  expect(formatSpeedTestReading(1234.5, "de")).toBe("1235");
});

test("a sparkline sample names its metric and shows the reading with its unit", () => {
  const download = speedTestSparklineTooltip({ label: "Download", unit: "Mbps", locale: "de" })(firstSample([94.123456, 80, 91]));
  expect(download).toEqual({ rows: [{ label: "Download", value: "94 Mbps" }] });

  const ping = speedTestSparklineTooltip({ label: "Ping", unit: "ms", locale: "de" })(firstSample([8.26, 12, 9]));
  expect(ping).toEqual({ rows: [{ label: "Ping", value: "8,3 ms" }] });
  expect(JSON.stringify([download, ping])).not.toMatch(/Value|Wert|"x"|"y"/);
});
