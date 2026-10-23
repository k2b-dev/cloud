import { expect, test } from "bun:test";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { createTrustedTextAwareness, InvalidSharedTextAwarenessError } from "./awareness";

const user = { userId: "alice", name: "Alice", color: "#61afef" };
const local = (state: unknown, client = 12, clock = 10) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, client);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
};
const decode = (bytes: Uint8Array) => {
  const decoder = decoding.createDecoder(bytes);
  expect(decoding.readVarUint(decoder)).toBe(1);
  return { id: decoding.readVarUint(decoder), clock: decoding.readVarUint(decoder), state: JSON.parse(decoding.readVarString(decoder)) };
};

test("trusted awareness replaces identity and envelope while preserving relative cursor positions", () => {
  const doc = new Y.Doc();
  try {
    doc.getText("codemirror").insert(0, "hello");
    const cursor = {
      anchor: Y.createRelativePositionFromTypeIndex(doc.getText("codemirror"), 1),
      head: Y.createRelativePositionFromTypeIndex(doc.getText("codemirror"), 4, -1),
    };
    const session = createTrustedTextAwareness({ clientId: 2 ** 32 + 5, textName: "codemirror", user });
    const update = decode(session.publish(local({ user: { userId: "victim", name: "Forged", color: "red", extra: true }, cursor })));
    expect(update).toEqual({ id: 2 ** 32 + 5, clock: 1, state: { user, writerId: 12, cursor: JSON.parse(JSON.stringify(cursor)) } });
    expect(Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(update.state.cursor.head), doc)?.index).toBe(4);
    expect(decode(session.publish(local({ cursor }, 12, 0))).clock).toBe(2);
    expect(decode(session.remove()!)).toEqual({ id: 2 ** 32 + 5, clock: 3, state: null });
    expect(session.remove()).toBeNull();
  } finally {
    doc.destroy();
  }
});

test("connection binding prevents alternate IDs and owns null removal even when first input names a victim", () => {
  const victim = 2 ** 32 + 8;
  const session = createTrustedTextAwareness({ clientId: 2 ** 32 + 9, textName: "codemirror", user });
  expect(decode(session.publish(local(null, victim, Number.MAX_SAFE_INTEGER)))).toEqual({ id: 2 ** 32 + 9, clock: 1, state: null });
  expect(() => session.publish(local({}, 55))).toThrow(InvalidSharedTextAwarenessError);
  expect(decode(session.publish(local({}, victim))).state).toEqual({ user, writerId: victim, cursor: null });
  expect(decode(session.publish(local(null, victim)))).toEqual({ id: 2 ** 32 + 9, clock: 3, state: null });
  expect(session.remove()).toBeNull();
  const reconnect = createTrustedTextAwareness({ clientId: 2 ** 32 + 10, textName: "codemirror", user });
  expect(decode(reconnect.publish(local({})))).toEqual({ id: 2 ** 32 + 10, clock: 1, state: { user, writerId: 12, cursor: null } });
});

test("malformed, multiple, trailing and unsupported states fail without binding or advancing the clock", () => {
  const session = createTrustedTextAwareness({ clientId: 2 ** 32 + 11, textName: "codemirror", user });
  const good = local({});
  const multiple = new Uint8Array(good);
  multiple[0] = 2;
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array([0]),
    multiple,
    good.slice(0, -1),
    new Uint8Array([...good, 0]),
    local([]),
    local({ other: 1 }),
    local({ writerId: 77 }),
    local({ cursor: { anchor: { tname: "codemirror", type: { client: 12, clock: 0 } }, head: { tname: "codemirror" } } }),
    local({ cursor: { anchor: {}, head: {} } }),
    local({ cursor: { anchor: { tname: "codemirror", item: { client: -1, clock: 0 } }, head: { tname: "codemirror" } } }),
    local({ cursor: { anchor: { tname: "codemirror", extra: 1 }, head: { tname: "codemirror" } } }),
  ])
    expect(() => session.publish(bytes)).toThrow(InvalidSharedTextAwarenessError);
  expect(decode(session.publish(local({ cursor: null }, 99))).clock).toBe(1);
});

test("cursor roots are constrained before resolution without changing document share keys", () => {
  const doc = new Y.Doc();
  const text = doc.getText("codemirror");
  const session = createTrustedTextAwareness({ clientId: 2 ** 32 + 12, textName: "codemirror", user });
  try {
    text.insert(0, "notes");
    const roots = [...doc.share.keys()];
    for (const tname of ["other", "unknown-one", "unknown-two"]) {
      const at = { tname, type: null, item: null, assoc: 0 };
      expect(() => session.publish(local({ cursor: { anchor: at, head: at } }))).toThrow(InvalidSharedTextAwarenessError);
      expect([...doc.share.keys()]).toEqual(roots);
    }
    const at = Y.createRelativePositionFromTypeIndex(text, text.length);
    const update = decode(session.publish(local({ cursor: { anchor: at, head: at } })));
    expect(update.state.writerId).toBe(12);
    expect(Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(update.state.cursor.head), doc)?.index).toBe(5);
    expect([...doc.share.keys()]).toEqual(roots);
    const custom = createTrustedTextAwareness({ clientId: 2 ** 32 + 13, textName: "body", user });
    const body = { tname: "body", type: null, item: null, assoc: -1 };
    expect(decode(custom.publish(local({ cursor: { anchor: body, head: body } })))).toEqual({
      id: 2 ** 32 + 13,
      clock: 1,
      state: { user, writerId: 12, cursor: { anchor: body, head: body } },
    });
  } finally {
    doc.destroy();
  }
});
