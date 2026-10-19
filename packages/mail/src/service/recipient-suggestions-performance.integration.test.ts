import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { anchor, fixtureTables, planLargeMailbox, seedLargeMailbox } from "../../test/fixtures/large-mailbox";
import { createRecipientMailboxFixture, recipientSuggestionNow as now } from "../../test/fixtures/recipient-suggestions";
import { migrate } from "../migrate";
import {
  listRecipientSuggestions,
  MAIL_RECIPIENT_SUGGESTION_P95_BUDGET_MS,
  MAIL_RECIPIENT_SUGGESTION_WINDOW,
  recipientSuggestionsQuery,
} from "./recipient-suggestions";

const suite = process.env.MAIL_PERFORMANCE_TESTS === "1" ? suiteFor("database", "nats", "valkey") : describe.skip;
const requested = Number.parseInt(process.env.MAIL_PERFORMANCE_MESSAGE_COUNT ?? "20000", 10);
const messages = Number.isFinite(requested) ? Math.min(100_000, Math.max(20_000, requested)) : 20_000;

suite("mailbox recipient suggestion performance", () => {
  let fixture: Awaited<ReturnType<typeof createRecipientMailboxFixture>>;
  beforeAll(async () => {
    await migrate();
    fixture = await createRecipientMailboxFixture();
    const plan = planLargeMailbox({ seed: 42, anchor, messages, conversations: 3_000, folders: 40 });
    expect(plan.messages.some((message) => message.from === "perf@example.test")).toBe(true);
    await seedLargeMailbox(sql, plan, { mailboxId: fixture.mailboxId, userIds: [fixture.user.id] });
    for (const table of fixtureTables) await sql.unsafe(`ANALYZE mail.${table}`);
    console.log(
      `Recipient fixture: ${messages} messages, 3000 conversations, outgoing from perf@example.test; fixed now ${now.toISOString()}`,
    );
  }, 300_000);
  afterAll(async () => {
    await fixture?.cleanup();
  });

  test("meets the p95 budget for common, name, rare and missing queries; prints candidate windows", async () => {
    const queries = ["co", "cont", "126@", "no-such-person"];
    const measure = async (label: string, run: () => Promise<unknown>) => {
      const timings: number[] = [];
      for (let iteration = 0; iteration < 45; iteration++) {
        const start = performance.now();
        await run();
        if (iteration >= 5) timings.push(performance.now() - start);
      }
      timings.sort((left, right) => left - right);
      const percentile = (p: number) => timings[Math.ceil(timings.length * p) - 1] ?? Number.NaN;
      const result = { label, samples: timings.length, p50: percentile(0.5), p95: percentile(0.95), max: timings.at(-1) };
      console.log(JSON.stringify(result));
      return result;
    };
    // Candidate windows measure the bare query (no permission check) so the chosen constant can be compared with larger ones.
    for (const window of [1_000, 2_000, 5_000, 10_000, 20_000]) {
      for (const query of queries) {
        const params = { mailboxId: fixture.mailboxId, query, limit: 8, window, now };
        await measure(`query window=${window} q=${query}`, () =>
          sql.begin(async (tx) => {
            await tx`SET LOCAL jit = off`;
            return recipientSuggestionsQuery(params, tx);
          }),
        );
      }
      const plan = await sql.begin(async (tx) => {
        await tx`SET LOCAL jit = off`;
        return tx<Array<{ "QUERY PLAN": string }>>`EXPLAIN (ANALYZE, BUFFERS) ${recipientSuggestionsQuery(
          { mailboxId: fixture.mailboxId, query: "co", limit: 8, window, now },
          tx,
        )}`;
      });
      console.log(`EXPLAIN window=${window}\n${plan.map((row) => row["QUERY PLAN"]).join("\n")}`);
    }
    // The budget applies to the full service call, permission check included, at the production window.
    const service = [];
    for (const query of queries)
      service.push(
        await measure(`service window=${MAIL_RECIPIENT_SUGGESTION_WINDOW} q=${query}`, async () => {
          const result = await listRecipientSuggestions({ context: fixture.context, mailboxId: fixture.mailboxId, query, limit: 8, now });
          if (!result.ok) throw new Error(result.error.message);
        }),
      );
    for (const result of service) expect(result.p95).toBeLessThan(MAIL_RECIPIENT_SUGGESTION_P95_BUDGET_MS);
  }, 600_000);
});
