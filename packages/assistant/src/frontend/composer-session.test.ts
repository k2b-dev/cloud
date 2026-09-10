import { expect, test } from "bun:test";
import { confirmComposerSave, editComposerSession, newComposerSession, observeComposerRevision } from "./composer-session";

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
