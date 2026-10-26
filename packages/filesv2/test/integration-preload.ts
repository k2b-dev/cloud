import { afterAll } from "bun:test";
import { sql } from "bun";
import { createDisposableDatabase, testInfra } from "../../../scripts/fixtures/test-infra";

/**
 * Filesv2 integration suites create stand-in `auth`/`settings`/`audit` tables
 * and truncate them, which is only safe in a database nobody else uses. The
 * default `sql` binds to `DATABASE_URL` on first use and Cloud modules use it
 * at import time, so the private database is claimed here, before any test
 * module loads. Run the suites with `bun test --isolate` so each file gets
 * its own fresh database.
 */
if (testInfra.database) {
  const database = await createDisposableDatabase("filesv2");
  process.env.DATABASE_URL = database.url;
  afterAll(async () => {
    await sql.close().catch(() => undefined);
    await database.drop();
  });
}
