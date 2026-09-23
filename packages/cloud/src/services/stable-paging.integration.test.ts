import { expect, test } from "bun:test";
import { sql } from "bun";
import { collectPages, descending, fixtureKeys } from "../../../../scripts/fixtures/stable-paging";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { accountLifecycle } from "./account-lifecycle";
import { accountsAppService } from "./accounts";
import { logging } from "./logging";
import { trace } from "./logging/trace";
import { notificationBatches, notifications } from "./notifications";
import { serviceAccountCredentials } from "./service-account-credentials";

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = databaseSuite();

/** Enough tied rows that a page size of three crosses several boundaries inside the tie. */
const ROWS = 12;

const range = (count: number) => Array.from({ length: count }, (_, index) => index);

suite("offset pages over rows that share one timestamp", () => {
  test("notification messages", async () => {
    const marker = `stable-paging-message-${crypto.randomUUID()}`;
    const ids = await sql.begin(async (tx) => {
      const created: string[] = [];
      for (const index of range(ROWS)) {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO notifications.messages (recipient, subject, content)
          VALUES (${`paging-${index}@example.test`}, ${marker}, 'fixture')
          RETURNING id
        `;
        created.push(row!.id);
      }
      return created;
    });
    try {
      const seen = await collectPages(async ({ page, offset, limit }) => {
        const result = await notifications.list({ page, offset, perPage: limit }, { isAdmin: true, search: marker });
        return result.notifications.map((item) => item.id);
      });
      expect(seen).toEqual(descending(ids));
    } finally {
      await sql`DELETE FROM notifications.messages WHERE subject = ${marker}`;
    }
  });

  test("notification batches", async () => {
    const marker = `stable-paging-batch-${crypto.randomUUID()}`;
    const ids = await sql.begin(async (tx) => {
      const created: string[] = [];
      for (const index of range(ROWS)) {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO notifications.batches (subject, body_markdown, body_html, selection_hash, status)
          VALUES (${marker}, 'fixture', '<p>fixture</p>', ${`${marker}-${index}`}, 'cancelled')
          RETURNING id
        `;
        created.push(row!.id);
      }
      return created;
    });
    try {
      const seen = await collectPages(async ({ page, limit }) => {
        const result = await notificationBatches.list({ page, perPage: limit, status: "cancelled" });
        return result.items.map((item) => item.id);
      });
      expect(fixtureKeys(seen, ids)).toEqual(descending(ids));
    } finally {
      await sql`DELETE FROM notifications.batches WHERE subject = ${marker}`;
    }
  });

  test("log entries", async () => {
    const source = `stable-paging-log-${crypto.randomUUID()}`;
    const ids = await sql.begin(async (tx) => {
      const created: string[] = [];
      for (const index of range(ROWS)) {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO logging.entries (source, message) VALUES (${source}, ${`fixture ${index}`}) RETURNING id::text
        `;
        created.push(row!.id);
      }
      return created;
    });
    try {
      const seen = await collectPages(async ({ page, offset, limit }) => {
        const result = await logging.list({ page, offset, perPage: limit }, { source });
        return result.entries.map((entry) => entry.id);
      });
      expect(seen).toEqual([...ids].sort((left, right) => Number(right) - Number(left)));
    } finally {
      await sql`DELETE FROM logging.entries WHERE source = ${source}`;
    }
  });

  test("trace spans", async () => {
    const source = `stable-paging-trace-${crypto.randomUUID()}`;
    const traceId = crypto.randomUUID().replaceAll("-", "");
    const spanIds = range(ROWS).map(() => crypto.randomUUID().replaceAll("-", "").slice(0, 16));
    await sql.begin(async (tx) => {
      for (const spanId of spanIds) {
        await tx`
          INSERT INTO logging.trace_spans (trace_id, span_id, name, source)
          VALUES (${traceId}, ${spanId}, 'fixture', ${source})
        `;
      }
    });
    try {
      const seen = await collectPages(async ({ page, offset, limit }) => {
        const result = await trace.list({ page, offset, perPage: limit }, { filter: { source } });
        return result.spans.map((span) => span.spanId);
      });
      expect(seen).toEqual(descending(spanIds));
    } finally {
      await sql`DELETE FROM logging.trace_spans WHERE source = ${source}`;
    }
  });

  test("service account credentials", async () => {
    const marker = `stable-paging-credential-${crypto.randomUUID()}`;
    const { accountId, ids } = await sql.begin(async (tx) => {
      const [account] = await tx<{ id: string }[]>`
        INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES (${marker}, 'resource_bound', 'stable-paging', 'fixture', ${marker})
        RETURNING id
      `;
      const created: string[] = [];
      for (const index of range(ROWS)) {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO auth.service_account_credentials (service_account_id, name, token_prefix, secret_hash)
          VALUES (${account!.id}::uuid, ${`fixture ${index}`}, ${`${marker}-${index}`}, 'not-a-secret')
          RETURNING id
        `;
        created.push(row!.id);
      }
      return { accountId: account!.id, ids: created };
    });
    try {
      const seen = await collectPages(async ({ page, limit }) => {
        const result = await serviceAccountCredentials.listOverview({
          pagination: { page, perPage: limit },
          filter: { serviceAccountId: accountId },
        });
        return result.items.map((item) => item.id);
      });
      expect(seen).toEqual(descending(ids));
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
    }
  });

  test("account requests", async () => {
    const marker = `stable-paging-request-${crypto.randomUUID()}`;
    const { userIds, ids } = await sql.begin(async (tx) => {
      const users: string[] = [];
      const created: string[] = [];
      for (const index of range(ROWS)) {
        const [user] = await tx<{ id: string }[]>`
          INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
          VALUES (${`${marker}-${index}`}, 'local', 'user', 'Paging Fixture', ${`${marker}-${index}@example.test`}, 'Paging', 'Fixture')
          RETURNING id
        `;
        const [request] = await tx<{ id: string }[]>`
          INSERT INTO auth.account_requests (user_id, status) VALUES (${user!.id}::uuid, 'denied') RETURNING id
        `;
        users.push(user!.id);
        created.push(request!.id);
      }
      return { userIds: users, ids: created };
    });
    try {
      const seen = await collectPages(async ({ page, limit }) => {
        const result = await accountsAppService.accountRequest.list({
          access: { userId: userIds[0]!, isAdmin: true },
          pagination: { page, perPage: limit },
          filter: { status: "denied" },
        });
        return result.items.map((item) => item.id);
      });
      expect(fixtureKeys(seen, ids)).toEqual(descending(ids));
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ANY(${sql.array(userIds, "uuid")})`;
    }
  });

  test("deleted accounts", async () => {
    const marker = `stable-paging-deleted-${crypto.randomUUID()}`;
    const ids = await sql.begin(async (tx) => {
      const created: string[] = [];
      for (const index of range(ROWS)) {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO auth.deleted_accounts (deleted_user_id, uid, reason)
          VALUES (${crypto.randomUUID()}::uuid, ${`${marker}-${index}`}, 'manual_delete')
          RETURNING id
        `;
        created.push(row!.id);
      }
      return created;
    });
    try {
      const seen = await collectPages(async ({ page, limit }) => {
        const result = await accountLifecycle.listDeletedAccounts({ page, perPage: limit, search: marker });
        return result.items.map((item) => item.id);
      });
      expect(seen).toEqual(descending(ids));
    } finally {
      await sql`DELETE FROM auth.deleted_accounts WHERE uid LIKE ${`${marker}-%`}`;
    }
  });

  test("account lifecycle reminders", async () => {
    const marker = `stable-paging-reminder-${crypto.randomUUID()}`;
    const ids = await sql.begin(async (tx) => {
      const created: string[] = [];
      for (const index of range(ROWS)) {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO auth.account_lifecycle_reminders (kind, threshold_days, target_expiry_at, uid)
          VALUES ('account_expiry', 7, now() + interval '7 days', ${`${marker}-${index}`})
          RETURNING id
        `;
        created.push(row!.id);
      }
      return created;
    });
    try {
      const seen = await collectPages(async ({ page, limit }) => {
        const result = await accountLifecycle.listReminderAudit({ page, perPage: limit, search: marker });
        return result.items.map((item) => item.id);
      });
      expect(seen).toEqual(descending(ids));
    } finally {
      await sql`DELETE FROM auth.account_lifecycle_reminders WHERE uid LIKE ${`${marker}-%`}`;
    }
  });
});
