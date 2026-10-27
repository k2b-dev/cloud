import { sql } from "bun";

export const migrateAiModelAccess = async (): Promise<void> => {
  await sql.begin(async (tx) => {
    await tx`CREATE SEQUENCE IF NOT EXISTS ai.model_access_revision`;
    await tx`CREATE TABLE IF NOT EXISTS ai.model_access_resources (
      model_id TEXT PRIMARY KEY,
      revision BIGINT NOT NULL DEFAULT nextval('ai.model_access_revision')
    )`;
    await tx`CREATE TABLE IF NOT EXISTS ai.model_access (
      model_id TEXT NOT NULL REFERENCES ai.model_access_resources(model_id) ON DELETE CASCADE,
      access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
      PRIMARY KEY (model_id, access_id), UNIQUE (access_id)
    )`;
  });
};
