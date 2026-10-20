import { expect, test } from "bun:test";
import { buildPulseWorkspaceHref, readWorkspacePathState } from "./routes";

test("base pages default to sources", () => {
  expect(readWorkspacePathState("/app/pulse/Base01", "Base01")).toEqual({ view: "sources", sourceId: "" });
  expect(readWorkspacePathState("/app/pulse/Base01/sources/Src001", "Base01")).toEqual({ view: "sources", sourceId: "Src001" });
  expect(readWorkspacePathState("/app/pulse/Base012/dashboards", "Base01").view).toBe("sources");
});

test("historical view URLs share the coming-back view without looking up deleted data", () => {
  for (const path of [
    "dashboards",
    "dashboards/Old001",
    "dashboards/Old001/edit",
    "explorer",
    "signals",
    "signals/events",
    "signals/states",
    "signals/metrics",
    "resources",
    "resources/service%3Aapi",
    "events",
    "events/order.created",
    "metrics",
    "metrics/cpu",
    "states",
    "states/online",
    "query-reference",
  ]) {
    expect(readWorkspacePathState(`/app/pulse/Base01/${path}`, "Base01")).toEqual({ view: "coming-back", sourceId: "" });
  }
});

test("navigation exposes sources and one stable coming-back URL", () => {
  expect(buildPulseWorkspaceHref({ baseId: "Base01", state: { view: "coming-back" } })).toBe("/app/pulse/Base01/dashboards");
  expect(buildPulseWorkspaceHref({ baseId: "Base01", state: { view: "sources" } })).toBe("/app/pulse/Base01/sources");
  expect(buildPulseWorkspaceHref({ baseId: "Base01", state: { view: "sources", sourceId: "Src001" } })).toBe(
    "/app/pulse/Base01/sources/Src001",
  );
  expect(buildPulseWorkspaceHref({ baseId: "", state: { view: "sources" } })).toBe("/app/pulse");
});
