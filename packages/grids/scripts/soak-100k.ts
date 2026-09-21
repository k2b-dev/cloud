#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { sql } from "bun";
import { requireDatabaseUrl } from "../../../scripts/fixtures/test-infra";
import { migrate } from "../src/migrate";
import { gridsService } from "../src/service";
import { ensureFieldIndex } from "../src/service/field-indexes";

const { values: options } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    rows: { type: "string", default: "100000" },
    batch: { type: "string", default: "2000" },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (options.help) {
  console.log(`Usage: CLOUD_TEST_DATABASE_URL=postgres://.../<name>_test bun packages/grids/scripts/soak-100k.ts [options]

Seeds a large Grids fixture on the test database and checks aggregate queries.

Options:
  --rows <n>    Records to seed (default 100000)
  --batch <n>   Records per insert batch (default 2000)
  --keep        Keep the fixture after the run
  --help        Show this help
`);
  process.exit(0);
}
requireDatabaseUrl();
const ROWS = Number(options.rows);
const BATCH = Number(options.batch);
const KEEP = options.keep;

const must = <T>(result: { ok: true; data: T } | { ok: false; error: { message: string } }): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};

const asNumber = (value: unknown, label: string): number => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new Error(`${label} is not numeric: ${String(value)}`);
  return n;
};

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
};

const assertNear = (actual: number, expected: number, label: string, epsilon = 1e-9): void => {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
};

const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  const value = await fn();
  const ms = Math.round(performance.now() - start);
  console.log(`${label}: ${ms}ms`);
  return value;
};

const buildExpected = (rows: number, categories: string[]) => {
  const groups = new Map<string, { count: number; sum: number }>();
  for (const category of categories) groups.set(category, { count: 0, sum: 0 });
  const tagCounts = new Map([
    ["even", 0],
    ["five", 0],
    ["ten", 0],
  ]);

  let amountGte900 = 0;
  let needle = 0;
  let activeSum = 0;

  for (let i = 0; i < rows; i++) {
    const amount = i % 1_000;
    const category = categories[i % categories.length]!;
    const group = groups.get(category)!;
    group.count += 1;
    group.sum += amount;

    if (amount >= 900) amountGte900 += 1;
    if (i % 100 === 0) needle += 1;
    if (category === "active") activeSum += amount;
    if (i % 2 === 0) tagCounts.set("even", tagCounts.get("even")! + 1);
    if (i % 5 === 0) tagCounts.set("five", tagCounts.get("five")! + 1);
    if (i % 10 === 0) tagCounts.set("ten", tagCounts.get("ten")! + 1);
  }

  return { amountGte900, needle, activeSum, groups, tagCounts };
};

const main = async () => {
  console.log(`Grids soak: rows=${ROWS} batch=${BATCH} keep=${KEEP ? "yes" : "no"}`);
  await migrate();

  const base = must(await gridsService.base.create({ name: `soak-${Date.now()}` }, null));
  const table = must(await gridsService.table.create({ baseId: base.id, name: "records" }, null));
  console.log(`base=${base.id} table=${table.id}`);

  try {
    const title = must(
      await gridsService.field.create(
        {
          tableId: table.id,
          name: "title",
          type: "text",
          presentable: true,
        },
        null,
      ),
    );
    const amount = must(
      await gridsService.field.create(
        {
          tableId: table.id,
          name: "amount",
          type: "number",
        },
        null,
      ),
    );
    const category = must(
      await gridsService.field.create(
        {
          tableId: table.id,
          name: "category",
          type: "single-select",
          config: {
            options: [
              { id: "new", label: "New" },
              { id: "active", label: "Active" },
              { id: "done", label: "Done" },
            ],
          },
        },
        null,
      ),
    );
    const day = must(
      await gridsService.field.create(
        {
          tableId: table.id,
          name: "day",
          type: "date",
        },
        null,
      ),
    );
    const active = must(
      await gridsService.field.create(
        {
          tableId: table.id,
          name: "active",
          type: "boolean",
        },
        null,
      ),
    );
    const note = must(
      await gridsService.field.create(
        {
          tableId: table.id,
          name: "note",
          type: "longtext",
        },
        null,
      ),
    );
    const tags = must(
      await gridsService.field.create(
        {
          tableId: table.id,
          name: "tags",
          type: "multi-select",
          config: {
            options: [
              { id: "even", label: "Even" },
              { id: "five", label: "Every five" },
              { id: "ten", label: "Every ten" },
            ],
          },
        },
        null,
      ),
    );

    await time("ensure indexes", async () => {
      for (const field of [title, amount, category, day, active]) {
        await ensureFieldIndex(field.id, field.type, table.id);
      }
    });

    const categories = ["new", "active", "done"];
    const startDate = Date.UTC(2025, 0, 1);
    const expected = buildExpected(ROWS, categories);

    await time("seed", async () => {
      for (let offset = 0; offset < ROWS; offset += BATCH) {
        const size = Math.min(BATCH, ROWS - offset);
        const values = Array.from({ length: size }, (_, j) => {
          const i = offset + j;
          const data = {
            [title.id]: `Item ${i}${i % 100 === 0 ? " needle" : ""}`,
            [amount.id]: i % 1_000,
            [category.id]: categories[i % categories.length],
            [day.id]: new Date(startDate + (i % 730) * 86_400_000).toISOString().slice(0, 10),
            [active.id]: i % 2 === 0,
            [note.id]: `Batch ${Math.floor(i / BATCH)}`,
            [tags.id]: [...(i % 2 === 0 ? ["even"] : []), ...(i % 5 === 0 ? ["five"] : []), ...(i % 10 === 0 ? ["ten"] : [])],
          };
          return sql`(${Bun.randomUUIDv7()}::uuid, ${table.id}::uuid, ${data}::jsonb, 1)`;
        });
        const tuples = values.reduce((acc, cur) => sql`${acc}, ${cur}`);
        await sql`
          INSERT INTO grids.records (id, table_id, data, version)
          VALUES ${tuples}
        `;
        if ((offset + size) % (BATCH * 10) === 0 || offset + size === ROWS) {
          console.log(`seeded ${offset + size}/${ROWS}`);
        }
      }
    });

    await time("analyze records", async () => {
      await sql`ANALYZE grids.records`;
    });

    await time("list filter+sort amount>=900", async () => {
      let cursor: string | null = null;
      let count = 0;
      let previousAmount = Number.POSITIVE_INFINITY;

      do {
        const result = must(
          await gridsService.record.list({
            tableId: table.id,
            cursor,
            limit: 500,
            filter: { fieldId: amount.id, op: ">=", value: 900 },
            sort: [{ fieldId: amount.id, direction: "desc" }],
          }),
        );
        for (const record of result.items) {
          const value = asNumber(record.data[amount.id], "amount");
          if (value < 900) throw new Error(`filter returned amount ${value} < 900`);
          if (value > previousAmount) {
            throw new Error(`sort violated: amount ${value} came after ${previousAmount}`);
          }
          previousAmount = value;
          count += 1;
        }
        cursor = result.nextCursor;
      } while (cursor);

      assertEqual(count, expected.amountGte900, "amount>=900 row count");
    });

    await time("search needle", async () => {
      let cursor: string | null = null;
      let count = 0;

      do {
        const result = must(
          await gridsService.record.list({
            tableId: table.id,
            cursor,
            limit: 500,
            search: { q: "needle", fieldIds: [title.id] },
            sort: [{ fieldId: title.id, direction: "asc" }],
          }),
        );
        for (const record of result.items) {
          const value = String(record.data[title.id] ?? "");
          if (!value.includes("needle")) throw new Error(`search returned non-matching title "${value}"`);
          count += 1;
        }
        cursor = result.nextCursor;
      } while (cursor);

      assertEqual(count, expected.needle, "needle search row count");
    });

    await time("aggregate sum amount where category=active", async () => {
      const result = must(
        await gridsService.record.aggregate({
          tableId: table.id,
          filter: { fieldId: category.id, op: "is", value: "active" },
          requests: [{ fieldId: amount.id, agg: "sum" }],
        }),
      );
      assertNear(asNumber(result[`${amount.id}__sum`], "active amount sum"), expected.activeSum, "active amount sum");
    });

    await time("group category count+avg", async () => {
      const result = must(
        await gridsService.record.group({
          tableId: table.id,
          groupBy: [{ fieldId: category.id }],
          aggregations: [
            { fieldId: "*", agg: "count" },
            { fieldId: amount.id, agg: "avg" },
          ],
        }),
      );
      assertEqual(result.buckets.length, categories.length, "category bucket count");
      for (const bucket of result.buckets) {
        const key = String(bucket.keys[0]);
        const group = expected.groups.get(key);
        if (!group) throw new Error(`unexpected category bucket "${key}"`);
        assertEqual(asNumber(bucket.values["*__count"], `${key} count`), group.count, `${key} count`);
        assertNear(asNumber(bucket.values[`${amount.id}__avg`], `${key} avg`), group.sum / group.count, `${key} avg`);
      }
    });

    await time("group multi-select tags top by count", async () => {
      const result = must(
        await gridsService.record.group({
          tableId: table.id,
          groupBy: [{ fieldId: tags.id }],
          aggregations: [{ fieldId: "*", agg: "count" }],
          groupSort: [{ fieldId: "*", agg: "count", direction: "desc" }],
          limit: 10,
        }),
      );
      assertEqual(result.buckets.length, expected.tagCounts.size, "tag bucket count");
      const ordered = [...expected.tagCounts.entries()].sort((a, b) => b[1] - a[1]);
      result.buckets.forEach((bucket, index) => {
        const [expectedTag, expectedCount] = ordered[index]!;
        assertEqual(bucket.keys[0], expectedTag, `tag bucket ${index} key`);
        assertEqual(asNumber(bucket.values["*__count"], `${expectedTag} count`), expectedCount, `${expectedTag} count`);
      });
      assertEqual(result.nextCursor, null, "aggregate-sorted group cursor");
      assertEqual(result.explode, true, "multi-select group explode flag");
    });

    await time("export first 1000 csv", async () => {
      const result = must(
        await gridsService.exporter.exportRecords({
          tableId: table.id,
          format: "csv",
          query: { limit: 1_000, sort: [{ fieldId: title.id, direction: "asc" }] },
          csv: { delimiter: ";" },
          fields: [
            { fieldId: title.id, label: "Title" },
            { fieldId: amount.id, label: "Amount" },
            { fieldId: category.id, label: "Category" },
          ],
        }),
      );
      if (!result.body.startsWith("id;Title;Amount;Category")) throw new Error("export header mismatch");
      assertEqual(result.truncated, false, "export truncated");
      assertEqual(result.body.trimEnd().split(/\r?\n/).length, 1_001, "export CSV line count");
    });
  } finally {
    if (KEEP) {
      console.log(`kept base ${base.id}`);
    } else {
      await sql`DELETE FROM grids.bases WHERE id = ${base.id}::uuid`;
      console.log("cleaned soak base");
    }
  }
};

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => sql.end());
