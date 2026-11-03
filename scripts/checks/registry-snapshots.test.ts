import { expect, test } from "bun:test";
import { checkSource } from "./registry-snapshots";

test.each([
  'import { capabilityRegistry as kv } from "../../cloud/src/_internal/registry"; kv().snapshot();',
  'import { appRegistry } from "@k2b/cloud";',
  'import * as cloud from "@k2b/cloud"; cloud.appRegistry().snapshot();',
  'import * as registry from "../../cloud/src/_internal/registry"; registry["capabilityRegistry"]();',
  'import * as registry from "../../cloud/src/_internal/registry"; const { appRegistry: kv } = registry;',
  'export { capabilityRegistry as raw } from "../../cloud/src/_internal/registry";',
  'export * from "../../cloud/src/_internal/registry";',
])("rejects raw registry access even when renamed: %s", (source) => {
  expect(checkSource("packages/core/src/request.ts", source).length).toBeGreaterThan(0);
});

test("permits observed reads, writers, tests, and exact instance-authority consumers", () => {
  expect(checkSource("packages/core/src/request.ts", 'import { listCapabilities, getApp } from "@k2b/cloud";')).toEqual([]);
  expect(checkSource("packages/cloud/src/contracts/index.ts", 'export * from "./registry";')).toEqual([]);
  expect(
    checkSource("packages/cloud/src/_internal/define-app.ts", 'import { appRegistry, capabilityRegistry } from "./registry";'),
  ).toEqual([]);
  expect(
    checkSource(
      "packages/cloud/src/services/identity/workload-runtime.ts",
      'import { appInstanceRegistry } from "../../_internal/registry";',
    ),
  ).toEqual([]);
  expect(
    checkSource(
      "packages/cloud/src/services/identity/workload-runtime.ts",
      'import { capabilityRegistry } from "../../_internal/registry";',
    ),
  ).toHaveLength(1);
  expect(checkSource("packages/cloud/src/request.test.ts", 'import { appRegistry } from "./registry";')).toEqual([]);
});
