import { describe, expect, test } from "bun:test";
import { createSharedTextProvider, type SharedTextProviderSnapshot } from "@k2b/cloud/browser/shared-text";
import { createTrustedTextAwareness, InvalidSharedTextAwarenessError } from "@k2b/cloud/shared-text";
import { encoding } from "@k2b/stdlib";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { MAX_DRAFT_DOCUMENT_PAYLOAD } from "./draft-document-contract";
import {
  decodeMailDraftDocumentMessage,
  MAIL_DRAFT_DOCUMENT_TERMINAL_CODES,
  MAX_DRAFT_AWARENESS_PAYLOAD,
  type MailDraftDocumentRequest,
  mailDraftDocumentMessageSchema,
  mailDraftDocumentRequestSchema,
} from "./draft-document-protocol";

const docId = "Draft1";
const generation = "1";
const publish = { type: "syncPublish", payload: { docId, generation, baseCursor: null, payload: "AAA=" } };
const push = {
  type: "syncPush" as const,
  payload: {
    docId,
    generation,
    updates: [{ payload: "AAA=", generation, actionId: "table-action", retainedColumn: true, cursor: "cursor" }],
  },
};
const varUint = (value: number) => {
  const bytes: number[] = [];
  do {
    const remainder = value % 128;
    value = Math.floor(value / 128);
    bytes.push(remainder | (value ? 128 : 0));
  } while (value);
  return bytes;
};
const awareness = (state: unknown, clientId = 42) => {
  const json = new TextEncoder().encode(JSON.stringify(state));
  return new Uint8Array([1, ...varUint(clientId), 1, ...varUint(json.length), ...json]);
};
const decodeAwareness = (bytes: Uint8Array) => {
  let index = 0;
  const uint = () => {
    let value = 0,
      factor = 1,
      byte: number;
    do {
      byte = bytes[index++]!;
      value += (byte & 127) * factor;
      factor *= 128;
    } while (byte & 128);
    return value;
  };
  expect(uint()).toBe(1);
  const clientId = uint(),
    clock = uint(),
    size = uint();
  return { clientId, clock, state: JSON.parse(new TextDecoder().decode(bytes.slice(index, index + size))) };
};

describe("Mail shared document normalized protocol", () => {
  test("requires generation and the original base cursor on sync; replay alone may start without a generation", () => {
    expect(mailDraftDocumentRequestSchema.safeParse(publish).success).toBe(true);
    for (const payload of [
      { docId, baseCursor: null, payload: "AAA=" },
      { docId, generation: null, baseCursor: null, payload: "AAA=" },
      { docId, generation, payload: "AAA=" },
      { ...publish.payload, generation: "01" },
      { ...publish.payload, generation: "9223372036854775808" },
    ])
      expect(mailDraftDocumentRequestSchema.safeParse({ type: "syncPublish", payload }).success).toBe(false);
    expect(
      mailDraftDocumentRequestSchema.safeParse({ type: "replayRequest", payload: { docId, generation: null, fromCursor: null } }).success,
    ).toBe(true);
  });

  test("awareness has a generation fence and no client identity or credentials", () => {
    const payload = { docId, generation, payload: "AA==" };
    expect(mailDraftDocumentRequestSchema.safeParse({ type: "awarenessPublish", payload }).success).toBe(true);
    for (const invalid of [
      { docId, payload: "AA==" },
      { ...payload, generation: null },
      { ...payload, token: "forged" },
      { ...payload, user: { name: "forged" } },
      { ...payload, name: "forged" },
      { ...payload, color: "red" },
      { ...payload, actor: "forged" },
    ])
      expect(mailDraftDocumentRequestSchema.safeParse({ type: "awarenessPublish", payload: invalid }).success).toBe(false);
  });

  test("rejects malformed envelopes, non-base64 bytes, UUIDs, unexpected messages and over-budget payloads", () => {
    for (const packet of [
      null,
      [],
      { ...publish, token: "forged" },
      { ...publish, payload: { ...publish.payload, payload: "???=" } },
      { ...publish, payload: { ...publish.payload, docId: "00000000-0000-4000-8000-000000000001" } },
      { ...publish, payload: { ...publish.payload, baseCursor: "x".repeat(257) } },
      { ...publish, payload: { ...publish.payload, payload: "A".repeat(MAX_DRAFT_DOCUMENT_PAYLOAD + 4) } },
      { type: "awarenessPublish", payload: { docId, generation, payload: "A".repeat(MAX_DRAFT_AWARENESS_PAYLOAD + 4) } },
      { type: "subscribe", payload: { fromCursor: null } },
    ])
      expect(mailDraftDocumentRequestSchema.safeParse(packet).success).toBe(false);
  });

  test("browser decoder preserves durable snapshots and action receipts, and rejects another draft", () => {
    expect(decodeMailDraftDocumentMessage(push, docId)).toEqual(push);
    expect(decodeMailDraftDocumentMessage({ ...push, payload: { ...push.payload, snapshot: true } }, docId)?.type).toBe("syncPush");
    expect(decodeMailDraftDocumentMessage(push, "Draft2")).toBeNull();
    expect(
      decodeMailDraftDocumentMessage(
        { type: "error", payload: { docId: "Draft2", code: "RESYNC_REQUIRED", message: "Reopen", reopen: true } },
        docId,
      ),
    ).toBeNull();
    expect(
      decodeMailDraftDocumentMessage(
        { type: "error", payload: { docId, code: "RESYNC_REQUIRED", message: "Reopen", reopen: true } },
        docId,
      ),
    ).toEqual({ type: "error", payload: { docId, code: "RESYNC_REQUIRED", message: "Reopen", reopen: true } });
  });

  test("every push and ordered update carries generation; awareness cannot advertise a durable snapshot", () => {
    for (const type of ["syncPush", "awarenessPush"]) {
      expect(
        mailDraftDocumentMessageSchema.safeParse({ type, payload: { docId, updates: [{ payload: "AA==", generation }] } }).success,
      ).toBe(false);
      expect(
        mailDraftDocumentMessageSchema.safeParse({ type, payload: { docId, generation, updates: [{ payload: "AA==" }] } }).success,
      ).toBe(false);
    }
    expect(
      decodeMailDraftDocumentMessage(
        { type: "awarenessPush", payload: { docId, generation, snapshot: true, updates: [{ payload: "AA==", generation }] } },
        docId,
      ),
    ).toBeNull();
  });
});

describe("Mail trusted awareness boundary", () => {
  const server = () =>
    createTrustedTextAwareness({
      clientId: 2 ** 32 + 7,
      textName: "codemirror",
      user: { userId: "authenticated", name: "Actual person", color: "#61afef" },
    });
  test("replaces forged identity, writer and clock using the server allocation", () => {
    const trusted = server();
    const packet = decodeAwareness(
      trusted.publish(awareness({ user: { userId: "victim", name: "Administrator", color: "red" }, cursor: null })),
    );
    expect(packet).toEqual({
      clientId: 2 ** 32 + 7,
      clock: 1,
      state: { user: { userId: "authenticated", name: "Actual person", color: "#61afef" }, writerId: 42, cursor: null },
    });
    expect(decodeAwareness(trusted.remove()!)).toEqual({ clientId: 2 ** 32 + 7, clock: 2, state: null });
    expect(trusted.remove()).toBeNull();
  });
  test("rejects another client's ID, extra states, trailing bytes and positions in another shared type", () => {
    const trusted = server();
    trusted.publish(awareness({ cursor: null }));
    for (const bytes of [
      awareness({ cursor: null }, 43),
      new Uint8Array([2, 42, 1, 0]),
      new Uint8Array([...awareness({ cursor: null }), 0]),
      awareness({ cursor: { anchor: { tname: "other" }, head: { tname: "codemirror" } } }),
      awareness({ writerId: 100, cursor: null }),
    ])
      expect(() => trusted.publish(bytes)).toThrow(InvalidSharedTextAwarenessError);
  });
});

test("the actual shared browser provider consumes Mail packets without treating replay or echo as durable storage", () => {
  class Socket {
    static readonly OPEN = 1;
    static current: Socket;
    readyState = 1;
    sent: MailDraftDocumentRequest[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
      Socket.current = this;
    }
    send(raw: string) {
      this.sent.push(mailDraftDocumentRequestSchema.parse(JSON.parse(raw)));
    }
    close() {
      this.readyState = 3;
    }
    message(packet: unknown) {
      this.onmessage?.({ data: JSON.stringify(packet) });
    }
  }
  const originalSocket = globalThis.WebSocket;
  const local = new Y.Doc();
  local.clientID = 101;
  const server = new Y.Doc();
  server.clientID = 202;
  server.getText("codemirror").insert(0, "Server");
  const awareness = new Awareness(local);
  const snapshots: SharedTextProviderSnapshot[] = [];
  const errors: string[] = [];
  Object.assign(globalThis, { WebSocket: Socket });
  const provider = createSharedTextProvider({
    doc: local,
    awareness,
    docId,
    initialGeneration: generation,
    maxSyncPayloadLength: MAX_DRAFT_DOCUMENT_PAYLOAD,
    terminalErrorCodes: MAIL_DRAFT_DOCUMENT_TERMINAL_CODES,
    reconnectDelayMs: () => 60_000,
    transport: {
      url: "ws://example.test/document/socket",
      encode: (packet) => packet,
      decode: (packet) => decodeMailDraftDocumentMessage(packet, docId),
      closeError: () => null,
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onError: (error) => errors.push(error.code),
  });
  try {
    provider.connect();
    const socket = Socket.current;
    socket.onopen?.();
    expect(socket.sent[0]).toEqual({ type: "replayRequest", payload: { docId, generation, fromCursor: null } });
    socket.message({
      type: "syncPush",
      payload: { docId, generation, snapshot: true, updates: [{ payload: encoding.toBase64(Y.encodeStateAsUpdate(server)), generation }] },
    });
    socket.message({ type: "replayReady", payload: { docId, generation, cursor: "base.1", peerId: "server-peer" } });
    expect(local.getText("codemirror").toString()).toBe("Server");
    expect(snapshots).toHaveLength(1);
    local.getText("codemirror").insert(6, " local");
    const publication = socket.sent.find((packet) => packet.type === "syncPublish");
    if (publication?.type !== "syncPublish") throw new Error("Provider did not publish input");
    expect(publication.payload.baseCursor).toBe("base.1");
    expect(provider.hasUnsentChanges()).toBe(true);
    socket.message({
      type: "syncPush",
      payload: { docId: "Other1", generation, updates: [{ payload: publication.payload.payload, generation, cursor: "forged" }] },
    });
    expect(provider.hasUnsentChanges()).toBe(true);
    socket.message({ type: "error", payload: { docId, code: "PENDING_PERSISTENCE", message: "Keep this draft open" } });
    expect(errors).toEqual(["PENDING_PERSISTENCE"]);
    expect(snapshots).toHaveLength(1);
    socket.message({
      type: "syncPush",
      payload: { docId, generation, updates: [{ payload: publication.payload.payload, generation, cursor: "base.2" }] },
    });
    expect(provider.hasUnsentChanges()).toBe(false);
    expect(snapshots).toHaveLength(1);
    Y.applyUpdate(server, encoding.fromBase64(publication.payload.payload));
    socket.message({
      type: "syncPush",
      payload: {
        docId,
        generation,
        snapshot: true,
        updates: [{ payload: encoding.toBase64(Y.encodeStateAsUpdate(server)), generation, cursor: "base.2" }],
      },
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.cursor).toBe("base.2");
    local.getText("codemirror").insert(12, " pending");
    socket.message({ type: "error", payload: { docId, code: "RESYNC_REQUIRED", message: "Copy before reopening", reopen: true } });
    expect(provider.recoveryInput().text).toBe("Server local pending");
    expect(provider.hasUnsentChanges()).toBe(true);
    provider.resume();
    expect(Socket.current).toBe(socket);
  } finally {
    provider.dispose();
    awareness.destroy();
    local.destroy();
    server.destroy();
    Object.assign(globalThis, { WebSocket: originalSocket });
  }
});
