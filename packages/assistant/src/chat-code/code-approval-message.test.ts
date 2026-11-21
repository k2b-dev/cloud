import { expect, test } from "bun:test";
import { codeApprovalMessage } from "./code-approval-message";
import type { CapabilityApproval } from "./runtime/capabilities";

const approval: CapabilityApproval = {
  status: "approval",
  id: "55555555-5555-4555-8555-555555555555",
  name: "weather.location.create",
  input: { name: "Berlin" },
  appName: "Weather",
  appIcon: "ti ti-cloud",
  appId: "weather",
  localId: "location.create",
  kind: "action",
  schemaHash: "a".repeat(64),
  approval: "rememberable",
  title: "Add location",
  review: null,
  allowAlways: false,
  scope: null,
};

test("an Action asked again after it changed says so above the usual card text", () => {
  expect(codeApprovalMessage(approval, "en")).toBe("Weather: Add location\nname: Berlin");
  expect(codeApprovalMessage({ ...approval, changed: true }, "en")).toBe(
    "Weather changed this action after you were asked, so nothing has run yet. Check the current version and approve it again.\nWeather: Add location\nname: Berlin",
  );
  expect(codeApprovalMessage({ ...approval, appName: "Wetter", title: "Ort hinzufügen", changed: true }, "de")).toBe(
    "Wetter hat diese Aktion geändert, nachdem du gefragt wurdest. Deshalb ist noch nichts passiert. Prüfe die aktuelle Fassung und gib sie erneut frei.\nWetter: Ort hinzufügen\nname: Berlin",
  );
});
