import { expect, test } from "bun:test";
import type { CodeCheckedVersionManifest } from "@k2b/cloud/contracts";
import type { catalogCache } from "@k2b/cloud/ssr/code-page/load";
import { codeAutomationName } from "@k2b/cloud/ssr/code-page/targets";
import { CodeActivationPreviewSchema } from "./activation-contracts";
import { describeCodeAutomations } from "./automation-view";

type Entry = CodeCheckedVersionManifest["entrypoints"][number];
const entry = (patch: Partial<Entry> & Pick<Entry, "kind" | "entrypoint">): Entry => ({ cron: null, file: "main.ts", line: 1, ...patch });
const place = { type: "spaces.space", id: "Spc001" };
const entrypoints = [
  entry({ kind: "schedule", entrypoint: "weekly", cron: "0 8 * * 1" }),
  entry({ kind: "schedule", entrypoint: "once", at: "2026-11-16T07:00:00.000Z" }),
  entry({ kind: "event", entrypoint: "event:spaces.item.due@1:place:0", event: { type: "spaces.item.due", version: 1, place } }),
  entry({ kind: "route", entrypoint: "route:GET:/", title: "Status", route: { method: "GET", path: "/", public: true, layout: "plain" } }),
  entry({ kind: "manual", entrypoint: "repair" }),
];
/** The registry as the switch-on preview reads it: the Spaces app names its event and its place type; nobody else is asked. */
const catalog = (async (appId: string) =>
  appId === "spaces"
    ? {
        ok: true,
        data: {
          appId: "spaces",
          appName: "Spaces",
          events: [{ type: "spaces.item.due", version: 1, title: "Item due" }],
          manifest: { types: [{ localId: "space", title: "Space", icon: "ti ti-layout-board" }], resourcePages: [] },
        },
      }
    : null) as unknown as ReturnType<typeof catalogCache>;

test("the switch-on preview names each automation in the strict preview shape: schedule, event and place, page audience without layout", async () => {
  const automations = await describeCodeAutomations(entrypoints, { codeId: "c_test01" }, catalog, "Europe/Berlin");
  // Every row fits the strict contract the card reads; a route carries only its method, path and audience.
  const Automation = CodeActivationPreviewSchema.shape.automations.unwrap().element;
  for (const automation of automations) expect(Automation.parse(automation)).toEqual(automation);
  expect(automations[3]).toEqual({ entrypoint: "route:GET:/", title: "Status", route: { method: "GET", path: "/", public: true } });
  expect(automations[1]).toEqual({ entrypoint: "once", at: "2026-11-16T07:00:00.000Z", timeZone: "Europe/Berlin" });
  expect(automations[2]?.event).toMatchObject({ type: "spaces.item.due", title: "Item due", place: { typeTitle: "Space", own: false } });
  expect(automations.map((automation) => codeAutomationName(automation, "", "de"))).toEqual([
    "Montags 08:00",
    "16.11.2026, 08:00 (Europe/Berlin)",
    "Item due · Space Spc001",
    "Status",
    "repair",
  ]);
});
