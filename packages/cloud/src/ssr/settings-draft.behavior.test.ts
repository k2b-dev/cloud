import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createSettingsDraft, oneStepFailure, SaveRejected, saveFailure, settingsSaveControls } from "./settings-draft";

type Values = { a: number; b: number };

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const form = (save: (value: Values, commit: (stored: Values) => void) => Promise<Values>) =>
  createRoot((dispose) => ({ form: createSettingsDraft<Values>({ initial: { a: 1, b: 1 }, locale: () => "en", save }), dispose }));

describe("createSettingsDraft", () => {
  test("a partial save keeps what reached the server as saved and the rest as draft", async () => {
    const { form: draft, dispose } = form(async (value, commit) => {
      commit({ ...value, b: 1 });
      throw new SaveRejected("b refused");
    });
    draft.update({ a: 2, b: 2 });
    await draft.save();
    expect(draft.draft()).toEqual({ a: 2, b: 2 });
    expect(settingsSaveControls()?.state).toBe("failed");
    draft.discard();
    // Discard returns to the stored state, which already has the saved a.
    expect(draft.draft()).toEqual({ a: 2, b: 1 });
    expect(settingsSaveControls()?.state).toBe("saved");
    dispose();
  });

  test("edits made while the save runs stay in the draft", async () => {
    const pending = deferred<Values>();
    const { form: draft, dispose } = form(() => pending.promise);
    draft.update({ a: 2 });
    const saving = draft.save();
    expect(settingsSaveControls()?.state).toBe("saving");
    draft.update({ b: 5 });
    pending.resolve({ a: 2, b: 1 });
    await saving;
    expect(draft.draft()).toEqual({ a: 2, b: 5 });
    expect(settingsSaveControls()?.state).toBe("draft");
    dispose();
  });

  test("a refused write is not saved; a broken connection or a server error leaves the outcome unclear", async () => {
    expect(saveFailure(409, "x")).toBeInstanceOf(SaveRejected);
    expect(saveFailure(500, "x")).not.toBeInstanceOf(SaveRejected);
    // A one-step endpoint that reports its own error did not store the value.
    expect(oneStepFailure(503, { message: "Unavailable" }, "x")).toBeInstanceOf(SaveRejected);
    expect(oneStepFailure(502, null, "x")).not.toBeInstanceOf(SaveRejected);
    const { form: draft, dispose } = form(async () => {
      throw saveFailure(502, "Bad gateway");
    });
    draft.update({ a: 3 });
    await draft.save();
    expect(settingsSaveControls()?.state).toBe("unknown");
    // An unclear outcome is checked, never saved again blindly.
    await draft.save();
    expect(draft.outcome()?.kind).toBe("unknown");
    dispose();
    expect(settingsSaveControls()).toBeNull();
  });

  test("rebase moves untouched fields to newer stored values and keeps edits", () => {
    const { form: draft, dispose } = form(async (value) => value);
    draft.update({ a: 5 });
    draft.rebase({ a: 9, b: 7 });
    expect(draft.draft()).toEqual({ a: 5, b: 7 });
    draft.rebase({ a: 9, b: 7 }, ["a"]);
    expect(draft.draft()).toEqual({ a: 9, b: 7 });
    expect(settingsSaveControls()?.state).toBe("saved");
    dispose();
  });
});
