/** Host subprocess: Bun's default sql/redis clients see only the run URLs at startup. */
import { z } from "zod";
import { assertRunUrl, monotonicMs } from "./measure";

const input = z
  .object({
    mailboxId: z.uuid(),
    remoteResourceId: z.uuid(),
    folderId: z.uuid(),
    uid: z.number().int().positive(),
    anchor: z.string(),
    postgresPort: z.number().int(),
    valkeyPort: z.number().int(),
  })
  .parse(await Bun.stdin.json());
assertRunUrl(process.env.DATABASE_URL ?? "", input.postgresPort, "postgresql:", "cloud_perf_test");
assertRunUrl(process.env.REDIS_URL ?? "", input.valkeyPort, "redis:");
const { sql, redis } = await import("bun");
const { ingestEnvelope } = await import("../../src/service/sync-runtime");
try {
  // Increasing UIDs must sort ahead of earlier arrivals, including at --runs 50.
  const date = new Date(Date.parse(input.anchor) - 86_400_000 + input.uid);
  const messageId = await sql.begin(async (tx) => {
    const id = await ingestEnvelope({
      db: tx,
      mailboxId: input.mailboxId,
      remoteResourceId: input.remoteResourceId,
      folderId: input.folderId,
      captureWorkflowTriggers: false,
      message: {
        remoteRef: { folderStableKey: "perf-folder-0", uidValidity: "1", uid: String(input.uid), modseq: "1" },
        providerMessageId: null,
        providerThreadId: null,
        messageId: `<arrival-${input.uid}@example.test>`,
        inReplyTo: null,
        references: [],
        subject: `Live arrival ${input.uid}`,
        sentAt: date,
        internalDate: date,
        sizeBytes: 512,
        flags: [],
        labels: [],
        mimeStructure: {},
        addresses: {
          from: [{ name: "Live sender", address: "arrival@example.test" }],
          to: [{ name: "Performance", address: "perf@example.test" }],
          cc: [],
          bcc: [],
          replyTo: [],
        },
      },
    });
    // ingestEnvelope is a primitive: the enclosing real sync batch enqueues this
    // mailbox-wide invalidation in the same transaction, then wakes its dispatcher.
    await tx`SELECT mail.enqueue_live_invalidation(${input.mailboxId}::uuid, NULL)`;
    return id;
  });
  const committedAt = monotonicMs();
  const [row] = await sql<
    { id: string }[]
  >`SELECT c.short_id AS id FROM mail.conversations c JOIN mail.conversation_messages cm ON cm.conversation_id = c.id WHERE cm.message_id = ${messageId}::uuid`;
  if (!row) throw new Error("Ingest produced no conversation");
  process.send?.({ committedAt, conversationId: row.id });
} finally {
  try {
    await sql.close();
  } finally {
    try {
      redis.close();
    } finally {
      process.disconnect?.();
    }
  }
}
