import { describe, expect, test } from "bun:test";

const SOURCE_ROOT = `${import.meta.dir}/..`;

const read = (path: string) => Bun.file(`${SOURCE_ROOT}/${path}`).text();

describe("trusted mutation origin boundary", () => {
  test("keeps current record, relation, and attachment SQL behind the owning services", async () => {
    const mutationSql =
      /(INSERT INTO grids\.records|UPDATE grids\.records|DELETE FROM grids\.record_links|INSERT INTO grids\.record_links|INSERT INTO grids\.file_attachments|UPDATE grids\.file_attachments|DELETE FROM grids\.file_attachments)/;
    const owners = new Set<string>();
    const files = new Bun.Glob("**/*.ts").scanSync({ cwd: SOURCE_ROOT });
    for (const path of files) {
      if (path.endsWith(".test.ts") || path.endsWith(".integration.test.ts") || path.includes("integration-fixtures")) continue;
      if (path === "migrate.ts" || path.startsWith("scripts/")) continue;
      if (mutationSql.test(await read(path))) owners.add(path);
    }

    expect([...owners].sort()).toEqual([
      "service/files.ts",
      "service/local-calculation-storage.ts",
      "service/record-finalization.ts",
      "service/record-write.ts",
      "service/relation-links.ts",
    ]);
  });

  test("classifies every public adapter in trusted server code", async () => {
    const [recordApi, customApps, capabilities, forms, workflows, templates] = await Promise.all(
      ["api/records.ts", "api/custom-apps.ts", "capabilities.ts", "service/form-submission.ts", "workflows.ts", "service/templates.ts"].map(
        read,
      ),
    );

    expect(recordApi).toContain('origin: "direct"');
    expect(customApps).toContain('origin: "direct"');
    expect(capabilities).toContain('"direct"');
    expect(forms?.match(/params\.actorId, "form"/g)).toHaveLength(2);
    expect(workflows).toContain('origin: "workflow"');
    expect(workflows).toContain('actorId(scope), "workflow"');
    expect(templates).toContain('origin: "direct"');
    expect(templates).toContain('actorId, "direct"');

    for (const source of [recordApi, customApps]) {
      expect(source).not.toMatch(/req\.(header|query).*mutation.?origin/i);
    }
  });
});
