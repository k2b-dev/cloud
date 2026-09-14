import { expect, test } from "bun:test";
import { browserUrl, parseBrowserFilter, telemetryModeUrl } from "./filter";

test("browser filters round-trip and mode links preserve compatible server filters", () => {
  const filter = { range: "6h" as const, appId: "mail", route: "/app/mail/:id", page: 2 };
  const url = new URL(browserUrl(filter), "https://cloud.test");
  expect(parseBrowserFilter(url)).toEqual(filter);
  expect(telemetryModeUrl(url, false)).toBe("/admin/observability/telemetry?range=6h&app=mail");
  expect(new URL(telemetryModeUrl(url, true), url).searchParams.get("page")).toBeNull();
  expect(parseBrowserFilter(new URL("https://cloud.test/?range=constructor&page=-2"))).toEqual({
    range: "24h",
    appId: "",
    route: "",
    page: 1,
  });
  expect(parseBrowserFilter(new URL("https://cloud.test/?page=Infinity")).page).toBe(1);
  expect(new URL(browserUrl(filter, { route: "", page: 1 }), url).searchParams.get("route")).toBeNull();
});
