import { expect, test, spyOn, afterEach, mock } from "bun:test";
import { compileCapabilityManifest } from "@valentinkolb/cloud/capabilities/testing";
import { kitCapabilities } from "../src/capabilities";
import { projects, ProjectError } from "../src/service";
import { CapabilityActionReviewSchema } from "@valentinkolb/cloud/contracts";
import { testIdentity } from "./identity";

const context = testIdentity("00000000-0000-4000-8000-000000000001");
afterEach(() => mock.restore());
test("capability manifest exposes source authoring without administration or SDK tools", () => {
  const manifest = compileCapabilityManifest("kit", kitCapabilities);
  expect(JSON.stringify(manifest)).toContain("source.apply");
  expect(Object.keys(kitCapabilities.actions)).toEqual(["source.apply"]);
  expect(Object.keys(kitCapabilities.queries)).toEqual(["app.search", "app.read", "source.read", "source.validate"]);
  expect(kitCapabilities.actions["source.apply"].destructive).toBe(true);
});
test("capability validation and apply share service revision guards and localized failures", async () => {
  const change = spyOn(projects, "changeSource").mockRejectedValue(new ProjectError(409, "REVISION_CONFLICT"));
  const input = { id: "abc123", expectedRevision: 2, upsert: [{ path: "helper.js", content: "" }], delete: [], edits: [] };
  const result = await kitCapabilities.actions["source.apply"].run(input, context);
  expect(result).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT", status: 409 } });
  expect(JSON.stringify(result)).toContain("andernorts");
  expect(change.mock.calls[0]?.[3]).toBe(true);
  await kitCapabilities.queries["source.validate"].run(input, context);
  expect(change.mock.calls[1]?.[3]).toBeUndefined();
});

test("action review keeps all affected paths within platform presentation limits", async () => {
  const input = {
    id: "abc123",
    expectedRevision: 1,
    upsert: [],
    edits: [],
    delete: Array.from({ length: 64 }, (_, i) => `${"a".repeat(180)}/${i}.js`),
  };
  spyOn(projects, "changeSource").mockResolvedValue({ id: input.id, revision: 1, entries: [], valid: true });
  spyOn(projects, "manifest").mockResolvedValue({
    id: input.id,
    name: "Test",
    description: "",
    persistenceEnabled: true,
    revision: 1,
    sdkVersion: 1,
    updatedAt: new Date().toISOString(),
    permission: "admin",
    files: [],
    entries: [],
  });
  const review = await kitCapabilities.actions["source.apply"].review(input, context);
  expect(review.ok).toBe(true);
  if (!review.ok) throw Error("Review failed");
  const parsed = CapabilityActionReviewSchema.parse(review.data);
  for (const path of input.delete) expect(parsed.details?.some((detail) => detail.value.includes(path))).toBe(true);
});
