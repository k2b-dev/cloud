import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { ImapFlow } from "imapflow";
import { encodePath, formatDateTime } from "imapflow/lib/tools.js";

type ImapAttribute = { type: string; value: string } | Array<{ type: string; value: string }>;
type ImapCommandResponse = {
  response: { attributes?: Array<{ section?: Array<{ value?: unknown }> }> };
  next(): void;
};
type StreamingImapFlow = ImapFlow & {
  exec(command: string, attributes: ImapAttribute[], options: { onPlusTag: () => Promise<void> }): Promise<ImapCommandResponse>;
  writeSocket: Writable;
  writeBytesCounter: number;
  close(): void;
};

export type ImapAppendError = Error & { effectPossible: boolean };

const appendError = (error: unknown, effectPossible: boolean): ImapAppendError => {
  const source = error instanceof Error ? error : new Error("IMAP APPEND failed");
  return Object.assign(source, { effectPossible });
};

const writeChunk = async (client: StreamingImapFlow, bytes: Buffer): Promise<void> => {
  client.writeBytesCounter += bytes.length;
  if (!client.writeSocket.write(bytes)) await once(client.writeSocket, "drain");
};

export const appendStream = async (params: {
  client: ImapFlow;
  path: string;
  source: Readable;
  byteLength: number;
  flags?: string[];
  internalDate?: Date;
}): Promise<{ uidValidity: string | null; uid: number | null }> => {
  if (!Number.isSafeInteger(params.byteLength) || params.byteLength < 0) {
    throw Object.assign(new Error("Invalid IMAP APPEND byte length"), { code: "INVALID_APPEND_LENGTH" });
  }
  const client = params.client as StreamingImapFlow;
  const flags = [...new Set(params.flags ?? [])].filter((flag) => /^\\?[A-Za-z0-9_$-]+$/.test(flag));
  const attributes: ImapAttribute[] = [{ type: "ATOM", value: encodePath(params.client, params.path) }];
  if (flags.length > 0) attributes.push(flags.map((flag) => ({ type: "ATOM", value: flag })));
  // Like imapflow's own APPEND, an invalid date leaves the internal date to the server.
  const internalDate = params.internalDate ? formatDateTime(params.internalDate) : undefined;
  if (internalDate) attributes.push({ type: "STRING", value: internalDate });
  // TEXT keeps the literal marker unquoted. The source itself is supplied only after the server continuation.
  attributes.push({ type: "TEXT", value: `{${params.byteLength}}` });

  let streamed = false;
  let streamedBytes = 0;
  let streamError: unknown;
  try {
    const response = await client.exec("APPEND", attributes, {
      onPlusTag: async () => {
        try {
          if (streamed) {
            throw Object.assign(new Error("IMAP server requested the APPEND literal more than once"), { code: "INVALID_APPEND_FLOW" });
          }
          streamed = true;
          for await (const value of params.source) {
            const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
            streamedBytes += bytes.length;
            if (streamedBytes > params.byteLength) {
              throw Object.assign(new Error("IMAP APPEND source exceeded its advertised size"), { code: "APPEND_SIZE_MISMATCH" });
            }
            await writeChunk(client, bytes);
          }
          if (streamedBytes !== params.byteLength) {
            throw Object.assign(new Error("IMAP APPEND source ended before its advertised size"), { code: "APPEND_SIZE_MISMATCH" });
          }
          await writeChunk(client, Buffer.from("\r\n"));
        } catch (error) {
          streamError = error;
          params.source.destroy();
          client.close();
          throw error;
        }
      },
    });
    if (!streamed) throw Object.assign(new Error("IMAP server did not request the APPEND literal"), { code: "INVALID_APPEND_FLOW" });
    const section = response.response.attributes?.[0]?.section ?? [];
    const appendUidIndex = section.findIndex((entry) => String(entry.value ?? "").toUpperCase() === "APPENDUID");
    const uidValidityValue = appendUidIndex >= 0 ? section[appendUidIndex + 1]?.value : null;
    const uidValue = appendUidIndex >= 0 ? section[appendUidIndex + 2]?.value : null;
    response.next();
    return {
      uidValidity: uidValidityValue != null && /^\d+$/.test(String(uidValidityValue)) ? String(uidValidityValue) : null,
      uid: uidValue != null && /^\d+$/.test(String(uidValue)) ? Number(uidValue) : null,
    };
  } catch (error) {
    params.source.destroy();
    client.close();
    throw appendError(streamError ?? error, streamed);
  }
};
