import { afterEach, beforeAll, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { createBlobReadable, storeReadableBlob } from "./message-blobs";

const chunkSize = 1024 * 1024;

suiteFor("database", "nats")("Mail blob streaming", () => {
  const blobs: string[] = [];
  beforeAll(migrate);
  afterEach(async () => {
    for (const id of blobs.splice(0)) await sql`DELETE FROM mail.message_part_blobs WHERE id = ${id}::uuid`;
  });

  for (const size of [0, chunkSize, 2 * chunkSize + 37]) {
    test(`preserves hash, byte length and chunk boundaries for ${size} bytes`, async () => {
      const bytes = Buffer.alloc(size);
      for (let i = 0; i < size; i++) bytes[i] = (i + Math.floor(i / chunkSize)) % 251;
      // Feed tiny chunks, then a chunk larger than the storage chunk, including a partial tail.
      const input = size === 0 ? [] : [bytes.subarray(0, 7), bytes.subarray(7, 64 * 1024), bytes.subarray(64 * 1024)];
      const blob = await storeReadableBlob(Readable.from(input), size);
      blobs.push(blob.id);
      expect(blob).toMatchObject({
        byteLength: size,
        chunkCount: Math.ceil(size / chunkSize),
        contentHash: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      });
      const chunks = await sql<{ position: number; bytes: Uint8Array }[]>`
        SELECT position, bytes FROM mail.message_part_chunks WHERE blob_id = ${blob.id}::uuid ORDER BY position
      `;
      expect(chunks).toHaveLength(blob.chunkCount);
      for (const [position, chunk] of chunks.entries()) {
        expect(chunk.position).toBe(position);
        expect(Buffer.from(chunk.bytes)).toEqual(bytes.subarray(position * chunkSize, (position + 1) * chunkSize));
      }
      const read = createBlobReadable(blob.id);
      expect(read.readableHighWaterMark).toBe(1);
      const received: Buffer[] = [];
      for await (const value of read) {
        if (!(value instanceof Uint8Array)) throw new TypeError("Expected blob bytes");
        received.push(Buffer.from(value));
      }
      expect(Buffer.concat(received)).toEqual(bytes);
      expect(read.destroyed).toBe(true);
    });
  }

  test("source errors destroy the stream and remove its unfinished upload", async () => {
    const error = new Error("broken source");
    const before = await sql<{ id: string }[]>`SELECT id FROM mail.message_part_blobs WHERE complete = false`;
    const source = Readable.from(
      (async function* () {
        yield Buffer.alloc(chunkSize + 1, 23);
        throw error;
      })(),
    );
    await expect(storeReadableBlob(source)).rejects.toBe(error);
    expect(source.destroyed).toBe(true);
    const after = await sql<{ id: string }[]>`SELECT id FROM mail.message_part_blobs WHERE complete = false`;
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
  });

  test("a size mismatch destroys the source and never finalizes the upload", async () => {
    const source = Readable.from([Buffer.from("short")]);
    await expect(storeReadableBlob(source, 100)).rejects.toMatchObject({ code: "BLOB_SIZE_MISMATCH" });
    expect(source.destroyed).toBe(true);
  });

  test("a missing chunk fails the readable and destroying a reader closes its iterator", async () => {
    const blob = await storeReadableBlob(Readable.from([Buffer.alloc(2 * chunkSize, 43)]));
    blobs.push(blob.id);
    const reader = createBlobReadable(blob.id);
    for await (const _value of reader) break;
    expect(reader.destroyed).toBe(true);
    await sql`DELETE FROM mail.message_part_chunks WHERE blob_id = ${blob.id}::uuid AND position = 1`;
    const broken = createBlobReadable(blob.id);
    const consume = async () => {
      for await (const _value of broken) {
        /* drain */
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: "MAIL_BLOB_INCOMPLETE" });
    expect(broken.destroyed).toBe(true);
  });
});
