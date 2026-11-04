import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { hydrateMessageFromSource } from "./message-hydration";

const suite = suiteFor("database", "nats", "valkey");

suite("Mail hydration of text Postgres cannot store", () => {
  const mailboxId = crypto.randomUUID();
  const blobIds: string[] = [];

  beforeAll(async () => {
    await sql`INSERT INTO mail.mailboxes (id, short_id, name) VALUES (${mailboxId}::uuid, ${newShortId()}, 'Hydration text tests')`;
  });

  afterAll(async () => {
    const blobs = await sql<{ id: string }[]>`
      SELECT source_blob_id AS id FROM mail.message_contents WHERE mailbox_id = ${mailboxId}::uuid AND source_blob_id IS NOT NULL
      UNION SELECT part.blob_id FROM mail.message_parts part JOIN mail.message_contents message ON message.id = part.message_id
        WHERE message.mailbox_id = ${mailboxId}::uuid AND part.blob_id IS NOT NULL
    `;
    blobIds.push(...blobs.map((blob) => blob.id));
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (blobIds.length)
      await sql`DELETE FROM mail.message_part_blobs WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${blobIds}::jsonb))`;
  });

  const pendingMessage = async (label: string): Promise<string> => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, internal_date, size_bytes, content_hash, hydration_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${label}@example.test>`}, ${new Date("2026-11-01T00:00:00Z")}, 1,
        ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'headers')
      RETURNING id
    `;
    return message!.id;
  };

  test("a multipart message with NUL bytes in its 8bit text, headers and attachment name loads without them", async () => {
    const id = await pendingMessage("nul-text");
    // Invented sample, shaped like the production message: 8bit inline text and a base64 attachment.
    const source = Buffer.from(
      [
        "Message-ID: <nul-text@example.test>",
        "From: Sender <sender@example.test>",
        "To: owner@example.test",
        "Subject: Quarterly\u0000 report",
        "List-Id: <list\u0000.example.test>",
        "Date: Sun, 01 Nov 2026 00:00:00 +0000",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        "Hallo\u0000 Welt, die Zahlen\u0000 sind da.",
        "--b1",
        'Content-Type: text/plain; name="zahlen\u0000.txt"',
        'Content-Disposition: attachment; filename="zahlen\u0000.txt"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("1;2;3\n").toString("base64"),
        "--b1--",
        "",
      ].join("\r\n"),
      "utf8",
    );
    expect((await hydrateMessageFromSource({ messageId: id, source: Readable.from([source]) })).status).toBe("hydrated");

    const [message] = await sql<{ hydration_status: string; plain_text: string; subject: unknown; list_id: unknown }[]>`
      SELECT hydration_status, plain_text, selected_headers->'subject' AS subject, selected_headers->'list-id' AS list_id
      FROM mail.message_contents WHERE id = ${id}::uuid
    `;
    expect(message?.hydration_status).toBe("complete");
    expect(message?.plain_text).toContain("Hallo Welt, die Zahlen sind da.");
    expect(JSON.stringify([message?.subject, message?.list_id])).not.toContain("\\u0000");
    const attachments = await sql<{ filename: string }[]>`SELECT filename FROM mail.attachments WHERE message_id = ${id}::uuid`;
    expect(attachments).toEqual([{ filename: "zahlen.txt" }]);
  });

  test("a write Postgres still refuses is logged with its SQLSTATE and the refused parameter, without the text", async () => {
    const id = await pendingMessage("refused-text");
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    const refused = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "22021",
      where: "unnamed portal parameter $1",
      table: undefined,
      column: undefined,
    });
    // The source cannot be stored, as when Postgres refuses the first write of the message.
    const source = new Readable({
      read() {
        this.destroy(refused);
      },
    });
    try {
      await expect(hydrateMessageFromSource({ messageId: id, source })).rejects.toBe(refused);
      expect(warnings.mock.calls).toContainEqual([
        "[mail:hydration]",
        "Mail message hydration failed",
        { messageId: id, code: "ERR_POSTGRES_SERVER_ERROR", sqlState: "22021", where: "unnamed portal parameter $1" },
      ]);
    } finally {
      warnings.mockRestore();
    }
    const [message] = await sql<{ hydration_status: string; hydration_error_code: string }[]>`
      SELECT hydration_status, hydration_error_code FROM mail.message_contents WHERE id = ${id}::uuid
    `;
    expect(message).toEqual({ hydration_status: "failed", hydration_error_code: "ERR_POSTGRES_SERVER_ERROR" });
  });
});
