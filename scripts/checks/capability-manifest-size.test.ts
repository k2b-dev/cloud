import { expect, test } from "bun:test";
import { z } from "zod";
import { compileCapabilities, MAX_CAPABILITY_MANIFEST_BYTES } from "../../packages/cloud/src/_internal/capabilities";
import { defineCapabilities } from "../../packages/cloud/src/contracts/capabilities";
import { CAPABILITY_MANIFEST_MARGIN_BYTES, capabilityManifestSizeIssue, largestManifestParts } from "./capability-manifest-size";

const query = (fields: number) => ({
  title: "Read",
  description: "Read one fixture.",
  input: z
    .object(Object.fromEntries(Array.from({ length: fields }, (_, index) => [`field${index}`, z.string().describe(`Field ${index}.`)])))
    .strict(),
  data: z.object({}).strict(),
  openWorld: false,
  run: () => ({ ok: true as const, data: { data: {} } }),
});
const manifest = compileCapabilities(
  "fixture",
  defineCapabilities({ protocolVersion: 2, queries: { small: query(1), large: query(40), medium: query(10) } }),
).manifest;
const size = new TextEncoder().encode(JSON.stringify(manifest)).byteLength;

test("a manifest inside the margin passes, and the margin keeps room below the registry limit", () => {
  expect(capabilityManifestSizeIssue(manifest)).toBeUndefined();
  expect(CAPABILITY_MANIFEST_MARGIN_BYTES).toBeLessThan(MAX_CAPABILITY_MANIFEST_BYTES);
});

test("a manifest within the margin of the limit fails and names its largest parts", () => {
  expect(largestManifestParts(manifest, 2).map((part) => part.part)).toEqual(["queries large", "queries medium"]);
  const issue = capabilityManifestSizeIssue(manifest, size + 100, 101);
  expect(issue).toStartWith(`fixture capability manifest is ${size.toLocaleString("en-US")} B, 100 B below`);
  expect(issue).toContain("Largest: queries large ");
  expect(issue!.indexOf("queries large")).toBeLessThan(issue!.indexOf("queries medium"));
  expect(capabilityManifestSizeIssue(manifest, size + 100, 100)).toBeUndefined();
});
