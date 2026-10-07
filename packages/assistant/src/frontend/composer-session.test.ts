import { expect, test } from "bun:test";
import {
  confirmComposerSave,
  editComposerSession,
  newComposerSession,
  observeComposerRevision,
  sendBesideComposer,
} from "./composer-session";

test("a remote refresh cannot lend its revision to old local text", () => {
  const session = newComposerSession(4);
  editComposerSession(session);
  expect(observeComposerRevision(session, 5)).toBe("conflict");
  expect(session.baseRevision).toBe(4);
  expect(session.conflict).toBe(true);
});
test("own save confirms a base without erasing edits made in flight", () => {
  const session = newComposerSession(4);
  editComposerSession(session);
  const generation = session.editGeneration;
  session.saving = true;
  editComposerSession(session);
  expect(observeComposerRevision(session, 5)).toBe("keep");
  confirmComposerSave(session, 5, generation);
  session.saving = false;
  expect(session.baseRevision).toBe(5);
  expect(session.dirty).toBe(true);
  expect(observeComposerRevision(session, 6)).toBe("conflict");
});
test("clean local content can adopt a newer saved draft but never an older response", () => {
  const session = newComposerSession(4);
  expect(observeComposerRevision(session, 5)).toBe("hydrate");
  expect(observeComposerRevision(session, 4)).toBe("keep");
  expect(session.baseRevision).toBe(5);
});
test("a message sent beside the composer puts back the draft it replaced, also when sending failed", async () => {
  const run = async (sent: boolean, content: boolean) => {
    const session = newComposerSession(4);
    const saves: boolean[] = [];
    const result = await sendBesideComposer(session, {
      send: async () => {
        // The host's send marks its own failure as a conflict.
        if (!sent) session.conflict = true;
        return sent;
      },
      hasContent: () => content,
      save: async () => saves.push(session.conflict),
    });
    return { result, saves, conflict: session.conflict };
  };
  // Sent: the server consumed the draft, so only what the person was writing goes back.
  expect(await run(true, true)).toEqual({ result: true, saves: [false], conflict: false });
  expect(await run(true, false)).toEqual({ result: true, saves: [], conflict: false });
  // Failed after replacing the draft: the composer's own content, also an empty one, replaces the sent message again.
  expect(await run(false, true)).toEqual({ result: false, saves: [false], conflict: false });
  expect(await run(false, false)).toEqual({ result: false, saves: [false], conflict: false });
});
test("a composer in conflict sends nothing beside it", async () => {
  const session = newComposerSession(4);
  session.conflict = true;
  let calls = 0;
  const count = async () => {
    calls++;
    return true;
  };
  expect(await sendBesideComposer(session, { send: count, hasContent: () => true, save: count })).toBe(false);
  expect(calls).toBe(0);
  expect(session.conflict).toBe(true);
});
