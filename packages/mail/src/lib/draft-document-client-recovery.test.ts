import { expect, test } from "bun:test";
import { encoding } from "@k2b/stdlib";
import * as Y from "yjs";
import { z } from "zod";
import { draftRecoveryRequestId } from "./draft-document-client-recovery";

test("two tabs recover different immutable source states independently of shared device metadata", async () => {
  const identity = { userId: "Usr001", draftId: "Draft1", generation: "1" };
  const own = new Y.Doc(),
    peer = new Y.Doc();
  own.clientID = 100;
  peer.clientID = 200;
  own.getText("codemirror").insert(0, "Tab A unsent text");
  peer.getText("codemirror").insert(0, "Tab B unsent text");
  try {
    const stateA = encoding.toBase64(Y.encodeStateAsUpdate(own));
    const stateB = encoding.toBase64(Y.encodeStateAsUpdate(peer));
    const requestA = await draftRecoveryRequestId(identity, stateA);
    const requestB = await draftRecoveryRequestId(identity, stateB);
    expect(z.string().uuid().parse(requestA)).toBe(requestA);
    expect(requestB).not.toBe(requestA);
    // Lost answer and a new tab/reload recompute the exact same immutable request.
    expect(await draftRecoveryRequestId({ ...identity }, stateA)).toBe(requestA);
    expect(await draftRecoveryRequestId({ ...identity }, stateB)).toBe(requestB);
    expect(await draftRecoveryRequestId({ ...identity, generation: "2" }, stateA)).not.toBe(requestA);
    Y.applyUpdate(own, Y.encodeStateAsUpdate(peer));
    const merged = await draftRecoveryRequestId(identity, encoding.toBase64(Y.encodeStateAsUpdate(own)));
    expect([requestA, requestB]).not.toContain(merged);
  } finally {
    own.destroy();
    peer.destroy();
  }
});
