import { afterAll, beforeAll, describe, expect } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { sql } from "bun";
import { Hono } from "hono";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { createGqlApi } from "../api/gql";
import type { DslQueryExecuteResponse } from "../contracts";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import * as fields from "../service/fields";
import { fromPublicRecordValues } from "../service/public-resources";
import { createMany } from "../service/record-write";
import { list } from "../service/records";

const reference = await Bun.file(new URL("../cli-references/index.md", import.meta.url)).text();
const section = reference.split("### Import a CSV file")[1]!.split("\n### ")[0]!;
const firstRowsQuery = section.match(/cld grids gql run Contacts --query '([^']+)'/)![1]!;
const converter = reference.match(/```ts\n(\/\/ csv-to-records\.ts[\s\S]*?)```/)![1]!;
const dir = await mkdtemp(join(tmpdir(), "grids-csv-recipe-db-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

/** A reader of the Base runs GQL through the same route `cld grids gql run` calls. */
const gqlAsReader = (id: string) => {
  const user: User = {
    id,
    uid: `csv-recipe-${id}`,
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "CSV",
    sn: "Recipe",
    displayName: "CSV Recipe",
    mail: `csv-recipe-${id}@example.test`,
    avatarHash: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
    ipa: null,
  };
  return new Hono<AuthContext>().route(
    "/gql",
    createGqlApi({
      requireAuthenticated: async (c, next) => {
        c.set("actor", { kind: "user", user });
        c.set("accessSubject", { type: "user", userId: user.id });
        c.set("user", user);
        await next();
      },
    }),
  );
};

describe("CSV import recipe", () => {
  postgresTest(
    "imports the converter's batches through public field IDs and lists them in CSV order, at most 500 per page",
    async () => {
      const baseId = testUuid();
      const basePublicId = testShortId();
      const tableId = testUuid();
      let accessId: string | undefined;
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${basePublicId}, 'CSV recipe test')`;
      try {
        await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${testShortId()}, ${baseId}::uuid, 'People')`;
        const name = await fields.create({ tableId, name: "Name", type: "text" }, null);
        const since = await fields.create({ tableId, name: "Since", type: "date" }, null);
        if (!name.ok) throw name.error;
        if (!since.ok) throw since.error;

        const names = Array.from({ length: 501 }, (_, index) => `Person ${String(index + 1).padStart(3, "0")}`);
        await Bun.write(join(dir, "csv-to-records.ts"), converter);
        await Bun.write(join(dir, "people.csv"), ["Name,Since", ...names.map((value) => `${value},2026-10-05`)].join("\n"));
        // columns.json maps headers to the public field IDs that `records shape` shows.
        await Bun.write(join(dir, "columns.json"), JSON.stringify({ Name: name.data.shortId, Since: since.data.shortId }));
        const run = Bun.spawnSync(["bun", "csv-to-records.ts", "people.csv", "columns.json"], {
          cwd: dir,
          env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
        });
        expect(run.exitCode, run.stderr.toString()).toBe(0);

        for (const file of (await readdir(dir)).filter((entry) => entry.startsWith("records-")).sort()) {
          const { items } = (await Bun.file(join(dir, file)).json()) as { items: Record<string, unknown>[] };
          // The import route converts public field IDs the same way before it creates the batch.
          const converted = await Promise.all(items.map((item) => fromPublicRecordValues(tableId, item)));
          const imported = await createMany(
            tableId,
            converted.map((item) => {
              if (!item.ok) throw item.error;
              return item.data;
            }),
            null,
            "direct",
          );
          if (!imported.ok) throw imported.error;
        }

        const first = await list({ tableId, limit: 1000 });
        if (!first.ok) throw first.error;
        expect(first.data.items.map((record) => record.data[name.data.id])).toEqual(names.slice(0, 500));
        expect(first.data.items[0]?.data[since.data.id]).toBe("2026-10-05");
        expect(first.data.nextCursor).not.toBeNull();
        const second = await list({ tableId, limit: 1000, cursor: first.data.nextCursor });
        if (!second.ok) throw second.error;
        expect(second.data.items.map((record) => record.data[name.data.id])).toEqual(names.slice(500));

        // The documented check prints the first rows in import order, with field names as column labels.
        // Grants need an existing account row, as in the GQL API integration test.
        const [reader] = await sql<{ id: string }[]>`SELECT id::text AS id FROM auth.users ORDER BY id LIMIT 1`;
        if (!reader) throw new Error("The CSV recipe test needs one auth.users row to grant Base read access");
        const [access] = await sql<{ id: string }[]>`
          INSERT INTO auth.access (user_id, permission) VALUES (${reader.id}::uuid, 'read'::auth.permission_level) RETURNING id::text AS id
        `;
        if (!access) throw new Error("Failed to grant Base read access");
        accessId = access.id;
        await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;
        const response = await gqlAsReader(reader.id).request(`/gql/by-base/${basePublicId}/execute`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: firstRowsQuery, pageSize: 100 }),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        const result = (await response.json()) as DslQueryExecuteResponse;
        if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
        expect(result.columns.map((column) => column.label)).toEqual(["Name", "Since"]);
        const nameKey = result.columns[0]!.key;
        expect(result.rows.map((row) => row.values[nameKey])).toEqual(names.slice(0, 10));
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
        if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      }
    },
    60_000,
  );
});
