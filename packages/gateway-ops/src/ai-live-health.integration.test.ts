import { afterAll, beforeAll, expect, test } from "bun:test";
import { migrateCloudAi } from "@k2b/cloud/ai";
import { sql } from "bun";
import { databaseSuite, testInfra, useFreshDatabase } from "../../../scripts/fixtures/test-infra";
import { migrate as migrateAuth } from "../../core/src/migrate/core/auth";
import { migrate as migrateEvents } from "../../core/src/migrate/core/events";
import { aiLiveFunctionOutdated } from "./ai-live-health";

const suite = databaseSuite();
let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;

// The check replaces a function every AI write calls, so it runs on a database of its own.
beforeAll(async () => {
  if (!testInfra.database) return;
  database = await useFreshDatabase("ai_live_health");
});

afterAll(async () => {
  if (!database) return;
  await sql.close();
  await database.drop();
});

suite("AI live function health", () => {
  test("reports nothing without AI, nothing for the current function, and the function an older Core restores", async () => {
    expect(await aiLiveFunctionOutdated()).toBe(false);

    await migrateAuth();
    await sql`CREATE SCHEMA settings`;
    await sql`CREATE TABLE settings.entries(key text PRIMARY KEY, value text)`;
    await migrateEvents();
    await migrateCloudAi();
    expect(await aiLiveFunctionOutdated()).toBe(false);

    // The body of the releases before AI moved to the platform outbox, as an older Core installs it when it starts.
    await sql`
      CREATE OR REPLACE FUNCTION ai.enqueue_live_for_user(
        p_change_id UUID, p_user_id UUID, p_conversation_short_id TEXT, p_project_short_id TEXT, p_domains TEXT[]
      ) RETURNS void AS $$
      BEGIN
        IF p_user_id IS NULL OR cardinality(p_domains) = 0 THEN RETURN; END IF;
        INSERT INTO ai.live_invalidation_outbox (change_id, audience_user_id, conversation_short_id, project_short_id, domains)
        VALUES (p_change_id, p_user_id, p_conversation_short_id, p_project_short_id,
          ARRAY(SELECT DISTINCT domain FROM unnest(p_domains) domain ORDER BY domain));
      END
      $$ LANGUAGE plpgsql
    `;
    expect(await aiLiveFunctionOutdated()).toBe(true);

    // The next start of a current Core restores its own body.
    await migrateCloudAi();
    expect(await aiLiveFunctionOutdated()).toBe(false);
  });
});
