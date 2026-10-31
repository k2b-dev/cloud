import { expect } from "bun:test";
import { sql } from "@k2b/cloud";
import { createMigratedDatabase, initializeTestPlatform, testFor } from "../../../../scripts/fixtures/test-infra";
import { testUuid } from "../integration-test-utils";
import { createDocumentIssuanceService, documentIssuanceService } from "./document-issuance";
import { getWorkflowRun } from "./workflow-runs";

// These services exist before the fixture selects its final database, as they
// do when imported by a route or another module before platform startup.
const documents = createDocumentIssuanceService();

testFor("database")("Grids readers use the current platform pool after a database reset", async () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousPool = sql;
  const database = await createMigratedDatabase("grids_clients");
  try {
    process.env.DATABASE_URL = database.url;
    await initializeTestPlatform("grids");
    expect(sql).not.toBe(previousPool);
    const [target] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
    expect(target?.name).toBe(database.name);
    for (const service of [documents, documentIssuanceService]) {
      const result = await service.getDocumentArtifact(testUuid(), "pdf");
      expect(result.ok).toBe(false);
    }
    expect(await getWorkflowRun(testUuid())).toBeNull();
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    try {
      await initializeTestPlatform("grids");
    } finally {
      await database.drop();
    }
  }
});
