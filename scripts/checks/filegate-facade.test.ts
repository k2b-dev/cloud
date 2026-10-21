import { expect, test } from "bun:test";
import { checkSource } from "./filegate-facade";

const file = "packages/filesv2/src/service/other.ts";

test.each([
  'import { Filegate } from "@k2b/filegate";',
  'import { RootClient } from "@k2b/filegate/client";',
  'import { Filegate as SDK } from "@k2b/filegate";',
  'import SDK from "@k2b/filegate";',
  'import * as SDK from "@k2b/filegate";',
  'import "@k2b/filegate";',
  'export { Filegate } from "@k2b/filegate";',
  'export { Filegate as SDK } from "@k2b/filegate/client";',
  'export * from "@k2b/filegate";',
  'export * as SDK from "@k2b/filegate";',
  'const sdk = import("@k2b/filegate");',
  "const sdk = import(`@k2b/filegate/client`);",
  'const sdk = require("@k2b/filegate");',
  'import sdk = require("@k2b/filegate");',
])("rejects SDK value access: %s", (source) => {
  const findings = checkSource(file, source);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.message).toContain("filegate-facade.ts");
  expect(findings[0]?.message).toContain("docs-site/docs/en/operations/files-history.md");
});
test.each([
  'import type { Filegate, RootClient } from "@k2b/filegate";',
  'import { type Filegate, type RootClient, FilegateError as StorageError } from "@k2b/filegate/client";',
  'import { FilegateError } from "@k2b/filegate";',
  'import * as helpers from "@k2b/filegate/utils";',
  'export type { Filegate } from "@k2b/filegate";',
  'export { type Filegate, FilegateError } from "@k2b/filegate";',
  'type Client = import("@k2b/filegate").Filegate;',
])("allows types, errors, and browser helpers: %s", (source) => expect(checkSource(file, source)).toEqual([]));
test.each([
  "packages/filesv2/src/service/filegate-facade.ts",
  "packages/filesv2/src/service/facade.test.ts",
  "packages/filesv2/test/fixture.ts",
  "packages/filesv2/src/files.browser-harness.tsx",
  "packages/filesv2/src/files.browser-suite.ts",
  "packages/other/src/service.ts",
])("exempts %s", (path) => expect(checkSource(path, 'import { Filegate } from "@k2b/filegate";')).toEqual([]));
