import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { integrationSchemaHash, quoteTestDatabase } from "./test-database-template";
import { schemaFixture } from "./test-database-template.test-fixture";

describe("integration template identity", () => {
  test("hashes Core, app baselines, helpers, assets, dependencies and the migration entry point", async () => {
    const fixture = await schemaFixture();
    try {
      const original = await integrationSchemaHash(fixture.root);
      expect(await integrationSchemaHash(fixture.root)).toBe(original);
      for (const [file, content] of Object.entries(fixture.files)) {
        await writeFile(join(fixture.root, file), `${content}\n`);
        expect(await integrationSchemaHash(fixture.root)).not.toBe(original);
        await writeFile(join(fixture.root, file), content);
      }
      const helper = join(fixture.root, "packages/core/src/shared-helper.ts");
      await writeFile(helper, "transitive migration dependency");
      expect(await integrationSchemaHash(fixture.root)).not.toBe(original);
      await rm(helper);
      const asset = join(fixture.root, "packages/core/src/avatar.svg");
      await writeFile(asset, "migration asset");
      expect(await integrationSchemaHash(fixture.root)).not.toBe(original);
      await rm(asset);
      await writeFile(join(fixture.root, "packages/mail/src/schema.test.ts"), "test edits do not change the schema");
      expect(await integrationSchemaHash(fixture.root)).toBe(original);
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects unsafe names before database creation and quotes identifiers", () => {
    for (const name of ["cloud", "cloud_test_extra", `${"a".repeat(59)}_test`, "nul\0_test", `${"ä".repeat(30)}_test`]) {
      expect(() => quoteTestDatabase(name)).toThrow();
    }
    expect(quoteTestDatabase(`${"a".repeat(58)}_test`)).toHaveLength(65);
    expect(quoteTestDatabase('quoted"_test')).toBe('"quoted""_test"');
  });
});
