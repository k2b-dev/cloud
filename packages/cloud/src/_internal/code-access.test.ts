import { expect, test } from "bun:test";
import { z } from "zod";
import type { CapabilityDefinitions } from "../contracts/capabilities";
import { CloudResourceReaderViewSchema } from "../contracts/capabilities";
import { compileCapabilities } from "./capabilities";
import { validateCodeOwners } from "./code-access";

const reader = {
  codeResourceTitle: () => "Item",
  title: "Read item",
  description: "Read the authorized item.",
  input: z.object({ id: z.string().min(1).max(512).describe("Resource ID.") }).strict(),
  data: z.object({ view: CloudResourceReaderViewSchema }),
  openWorld: false,
  run: async () => ({ ok: true as const, data: { data: { view: { title: "Item", permission: "read" as const } } } }),
};
const definitions: CapabilityDefinitions = {
  protocolVersion: 2,
  types: { item: { title: "Item", description: "An item.", reader: "item.read", access: { readable: () => [] } } },
  queries: { "item.read": reader },
  code: { owners: ["item"], pages: { item: "/app/inventory/{id}/code" } },
};
test("owner and page contract and resource readable survive without generating rights capabilities", () => {
  const compiled = compileCapabilities("inventory", definitions);
  expect(compiled.manifest.code).toEqual({ owners: ["item"], pages: { item: "/app/inventory/{id}/code" } });
  expect([...compiled.actions.keys()]).toEqual([]);
  expect([...compiled.queries.keys()]).toEqual(["item.read", "item.readable"]);
});
test("owners must have a local reader with the read-only lifecycle projection", () => {
  expect(() => validateCodeOwners({ ...definitions, code: { owners: ["missing"] } })).toThrow("declared type with a reader");
  expect(() => validateCodeOwners({ ...definitions, queries: { "item.read": { ...reader, codeResourceTitle: undefined } } })).toThrow(
    "codeResourceTitle",
  );
  expect(() => validateCodeOwners({ ...definitions, code: { owners: [], pages: { item: "/app/inventory/{id}/code" } } })).toThrow(
    "not a declared owner",
  );
  expect(() => validateCodeOwners({ ...definitions, code: { owners: ["item"], pages: { item: "https://elsewhere/{id}" } } })).toThrow(
    "needs a path",
  );
});
test("obsolete adapter fields are rejected even in dynamically assembled declarations", () => {
  expect(() => validateCodeOwners({ ...definitions, code: { owners: ["item"], ...{ access: {} } } })).toThrow("unsupported field access");
  expect(() =>
    validateCodeOwners({
      ...definitions,
      types: { item: { ...definitions.types!.item!, access: { readable: () => [], ...{ grant: () => true } } } },
    }),
  ).toThrow("unsupported function grant");
});
