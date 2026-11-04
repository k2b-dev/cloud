import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { createBlobReadable } from "./message-blobs";
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

  // Invented samples shaped like the production message: an HTML part, a base64 text/plain attachment
  // and an 8bit inline text/plain part. Each places NUL or invalid UTF-8 in one spot.
  const html = Buffer.from("<p>Die Zahlen sind da.</p>").toString("base64");
  const multipart = (variant: { headers?: readonly string[]; filename?: string; attachment?: Buffer; inline?: Buffer }) =>
    Buffer.concat([
      Buffer.from(
        [
          "Message-ID: <text-sample@example.test>",
          "From: Sender <sender@example.test>",
          "To: owner@example.test",
          "Subject: Quarterly report",
          ...(variant.headers ?? []),
          "Date: Sun, 01 Nov 2026 00:00:00 +0000",
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="b1"',
          "",
          "--b1",
          "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          html,
          "--b1",
          'Content-Type: text/plain; name="zahlen.txt"',
          `Content-Disposition: attachment; ${variant.filename ?? 'filename="zahlen.txt"'}`,
          "Content-Transfer-Encoding: base64",
          "",
          (variant.attachment ?? Buffer.from("1;2;3\n")).toString("base64"),
          "--b1",
          "Content-Type: text/plain; charset=UTF-8",
          "Content-Transfer-Encoding: 8bit",
          "Content-Disposition: inline",
          "",
          "",
        ].join("\r\n"),
      ),
      variant.inline ?? Buffer.from("Hallo Welt, die Zahlen sind da."),
      Buffer.from("\r\n--b1--\r\n"),
    ]);
  const bytes = (...parts: Array<string | number[]>) =>
    Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part) : Buffer.from(part))));
  const storable = (value: unknown) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return !text.includes("\u0000") && !text.includes("\\u0000") && text.isWellFormed();
  };
  const readBlob = async (blobId: string): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of createBlobReadable(blobId)) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  };

  test.each([
    { name: "NUL in the 8bit inline text", inline: bytes("Hallo", [0], " Welt, die Zahlen", [0], " sind da.") },
    { name: "invalid UTF-8 in the 8bit inline text", inline: bytes("Gr", [0xfc], "e und ", [0xc3, 0x28], " Zahlen ", [0xff]) },
    { name: "NUL and invalid UTF-8 in the base64 text attachment", attachment: bytes("1;2", [0, 0xff, 0xc3], ";3\n") },
    { name: "NUL and invalid UTF-8 in an RFC 2231 file name", filename: "filename*=utf-8''zahlen%00%FF.txt" },
    { name: "NUL in an encoded-word file name", filename: 'filename="=?utf-8?Q?zahlen=00.txt?="' },
    {
      name: "NUL in a quoted file name and in headers",
      filename: 'filename="zahlen\u0000.txt"',
      headers: ["List-Id: <list\u0000.example.test>", "X-Note: a\u0000b"],
    },
  ])("a message with $name loads, and its attachment keeps its bytes", async (variant) => {
    const id = await pendingMessage(`text-${crypto.randomUUID()}`);
    const source = multipart(variant);
    expect((await hydrateMessageFromSource({ messageId: id, source: Readable.from([source]) })).status).toBe("hydrated");

    const [message] = await sql<{ hydration_status: string; plain_text: string | null; sanitized_html: string | null; headers: unknown }[]>`
      SELECT hydration_status, plain_text, sanitized_html, selected_headers AS headers FROM mail.message_contents WHERE id = ${id}::uuid
    `;
    expect(message?.hydration_status).toBe("complete");
    for (const value of [message?.plain_text, message?.sanitized_html, message?.headers]) expect(storable(value ?? "")).toBe(true);
    expect(message?.sanitized_html).toContain("Die Zahlen sind da.");
    const attachments = await sql<{ filename: string | null; blob_id: string }[]>`
      SELECT filename, blob_id FROM mail.attachments WHERE message_id = ${id}::uuid
    `;
    expect(attachments).toHaveLength(1);
    expect(storable(attachments[0]!.filename ?? "")).toBe(true);
    expect(attachments[0]!.filename).toStartWith("zahlen");
    // The attachment keeps the bytes the sender sent.
    expect(await readBlob(attachments[0]!.blob_id)).toEqual(variant.attachment ?? Buffer.from("1;2;3\n"));
  });

  test("a write Postgres still refuses is logged with its SQLSTATE and the refused parameter, never with what it wrote", async () => {
    const id = await pendingMessage("refused-text");
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    const refused = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "22021",
      where: "unnamed portal parameter $1 = '...Hallo...'",
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
        { messageId: id, code: "ERR_POSTGRES_SERVER_ERROR", sqlState: "22021", parameter: 1 },
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
