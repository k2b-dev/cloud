import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { appendStream } from "./imap-append-stream";

const mockClient = (options: { requestContinuation?: boolean; swallowContinuationError?: boolean } = {}) => {
  const chunks: Buffer[] = [];
  let closed = false;
  let nextCalled = false;
  let attributes: unknown[] = [];
  const client = {
    capabilities: new Map<string, boolean | number>(),
    enabled: new Set<string>(),
    writeBytesCounter: 0,
    writeSocket: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    close() {
      closed = true;
    },
    async exec(_command: string, commandAttributes: unknown[], execOptions: { onPlusTag: () => Promise<void> }) {
      attributes = commandAttributes;
      if (options.requestContinuation !== false) {
        try {
          await execOptions.onPlusTag();
        } catch (error) {
          if (!options.swallowContinuationError) throw error;
          throw Object.assign(new Error("Connection closed during APPEND"), { code: "CONNECTION_CLOSED" });
        }
      }
      return {
        response: {
          attributes: [{ section: [{ value: "APPENDUID" }, { value: "42" }, { value: "7" }] }],
        },
        next() {
          nextCalled = true;
        },
      };
    },
  };
  return {
    client,
    get bytes() {
      return Buffer.concat(chunks);
    },
    get closed() {
      return closed;
    },
    get nextCalled() {
      return nextCalled;
    },
    get attributes() {
      return attributes;
    },
  };
};

describe("streaming IMAP APPEND", () => {
  test("writes the exact literal after continuation and parses APPENDUID", async () => {
    const mock = mockClient();
    const result = await appendStream({
      client: mock.client as never,
      path: "Sent",
      source: Readable.from([Buffer.from("first"), Buffer.from(" second")]),
      byteLength: 12,
      flags: ["\\Seen"],
      internalDate: new Date("2026-07-12T12:00:00.000Z"),
    });

    expect(result).toEqual({ uidValidity: "42", uid: 7 });
    expect(mock.bytes.toString()).toBe("first second\r\n");
    expect(mock.client.writeBytesCounter).toBe(14);
    expect(mock.nextCalled).toBe(true);
    expect(mock.closed).toBe(false);
    expect(mock.attributes).toEqual([
      { type: "ATOM", value: "Sent" },
      [{ type: "ATOM", value: "\\Seen" }],
      { type: "STRING", value: "12-Jul-2026 12:00:00 +0000" },
      { type: "TEXT", value: "{12}" },
    ]);
  });

  test("leaves the internal date to the server when the given date is invalid", async () => {
    const mock = mockClient();
    await appendStream({
      client: mock.client as never,
      path: "Sent",
      source: Readable.from([Buffer.from("body")]),
      byteLength: 4,
      internalDate: new Date(Number.NaN),
    });
    expect(mock.attributes).toEqual([
      { type: "ATOM", value: "Sent" },
      { type: "TEXT", value: "{4}" },
    ]);
  });

  test("fails closed with the source error when the advertised length is wrong", async () => {
    const mock = mockClient({ swallowContinuationError: true });
    await expect(
      appendStream({
        client: mock.client as never,
        path: "Sent",
        source: Readable.from([Buffer.from("short")]),
        byteLength: 10,
      }),
    ).rejects.toMatchObject({ code: "APPEND_SIZE_MISMATCH", effectPossible: true });
    expect(mock.closed).toBe(true);
    expect(mock.nextCalled).toBe(false);
  });

  test("rejects a server that never requests the synchronizing literal", async () => {
    const mock = mockClient({ requestContinuation: false });
    await expect(
      appendStream({
        client: mock.client as never,
        path: "Sent",
        source: Readable.from([]),
        byteLength: 0,
      }),
    ).rejects.toMatchObject({ code: "INVALID_APPEND_FLOW", effectPossible: false });
    expect(mock.closed).toBe(true);
  });
});
