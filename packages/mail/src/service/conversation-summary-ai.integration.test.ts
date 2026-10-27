import { expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { generateConversationSummaryAi } from "./conversation-summary-ai";

suiteFor("database", "nats")("summary source snapshot", () => {
  test("legacy links remain readable while the captured sequence excludes later messages", async () => {
    const mailboxId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const now = new Date("2026-10-27T12:00:00Z");
    try {
      await sql`INSERT INTO mail.mailboxes(id,short_id,name) VALUES (${mailboxId}::uuid,${newShortId()},'Summary source')`;
      await sql`INSERT INTO mail.conversations(id,short_id,mailbox_id,subject,latest_message_at)
        VALUES (${conversationId}::uuid,${newShortId()},${mailboxId}::uuid,'Snapshot',${now})`;
      let boundary: string | null = null;
      for (const [index, text] of ["Legacy answer", "Captured answer", "Future answer"].entries()) {
        const messageId = crypto.randomUUID();
        await sql`INSERT INTO mail.message_contents
          (id,short_id,mailbox_id,message_id,subject,normalized_subject,internal_date,size_bytes,content_hash,hydration_status,plain_text)
          VALUES (${messageId}::uuid,${newShortId()},${mailboxId}::uuid,${`<${messageId}@example.test>`},'Snapshot','snapshot',${new Date(now.getTime() + index * 1000)},100,${String(index).padStart(64, "0")},'complete',${text})`;
        const [link] = await sql<
          { seq: string | null }[]
        >`INSERT INTO mail.conversation_messages(conversation_id,message_id,position,link_seq)
          VALUES (${conversationId}::uuid,${messageId}::uuid,${index},${index === 0 ? sql`NULL` : sql`nextval('mail.conversation_link_seq')`}) RETURNING link_seq::text AS seq`;
        if (index === 1) boundary = link?.seq ?? null;
      }
      expect(boundary).not.toBeNull();
      for (const throughMessageSeq of [null, boundary]) {
        let calls = 0;
        const summary = await generateConversationSummaryAi(
          {
            mailboxId,
            conversationId,
            style: "short",
            mode: "replace",
            previousSummary: null,
            effectKey: crypto.randomUUID(),
            sourceRevision: "1",
            throughMessageSeq,
            signal: new AbortController().signal,
          },
          {
            runTask: async (task) => {
              calls++;
              const source = JSON.stringify(task.request.input);
              expect(source).toContain("Legacy answer");
              expect(source).not.toContain("Future answer");
              if (throughMessageSeq) expect(source).toContain("Captured answer");
              else expect(source).not.toContain("Captured answer");
              return { output: { summary: "Snapshot summary" }, usage: null, input: task.request.input };
            },
          },
        );
        expect(calls).toBe(1);
        expect(summary.coveredMessageCount).toBe(throughMessageSeq ? 2 : 1);
        expect(summary.truncated).toBe(false);
      }
    } finally {
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
  });
});
