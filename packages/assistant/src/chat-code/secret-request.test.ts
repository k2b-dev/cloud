import { expect, test } from "bun:test";
import {
  createSecretRequest,
  type SecretRequestEntry,
  type SecretRequestFailure,
  type SecretRequestPorts,
  type SecretRequestState,
} from "./secret-request";

const privateValue = "fixture-key-never-in-results";
const destination = { origin: "https://api.example.com", pathPrefix: "/v1", headers: ["authorization"] };
const entry = (configured = true): SecretRequestEntry => ({
  revision: "11111111-1111-4111-8111-111111111111",
  configured,
  binding: destination,
  valueSetAt: "2026-11-03T12:00:00Z",
  valueSetBy: { id: "22222222-2222-4222-8222-222222222222", name: "Lea Brandt" },
});
const input = (code: boolean) => ({
  name: "API",
  origin: destination.origin,
  header: "authorization",
  prefix: code ? "" : "Bearer ",
  ...(code ? { target: { code: "Abc234", pathPrefix: "/v1" } } : {}),
});
function fixture(code = false, initial: SecretRequestEntry | null = null) {
  let current = initial;
  let error: SecretRequestFailure | null = null;
  let listError: SecretRequestFailure | null = null;
  let allowed: boolean | null = true;
  const writes: Parameters<SecretRequestPorts["save"]>[0][] = [];
  const calls: string[] = [];
  let finish: (() => void) | undefined;
  const ports: SecretRequestPorts = {
    async list() {
      calls.push("list");
      return listError ?? { ok: true, entry: current };
    },
    async check() {
      calls.push("check");
      return allowed;
    },
    async save(value) {
      calls.push("save");
      writes.push(value);
      if (finish)
        await new Promise<void>((done) => {
          finish = done;
        });
      return error ?? { ok: true };
    },
  };
  const controller = createSecretRequest(input(code), ports);
  const states: SecretRequestState["state"][] = [];
  controller.subscribe((state) => states.push(state.state));
  return {
    controller,
    states,
    writes,
    calls,
    setEntry: (next: SecretRequestEntry | null) => {
      current = next;
    },
    fail: (next: SecretRequestFailure | null) => {
      error = next;
    },
    listFail: (next: SecretRequestFailure | null) => {
      listError = next;
    },
    allow: (next: boolean | null) => {
      allowed = next;
    },
    pause: () => {
      finish = () => {};
    },
    finish: () => finish?.(),
  };
}
for (const code of [false, true]) {
  test(`${code ? "code" : "chat"}: open → entered/reveal → saving → one saved receipt, no value`, async () => {
    const f = fixture(code);
    const c = f.controller;
    await c.start();
    expect(c.state.state).toBe("open");
    c.input(privateValue);
    expect(c.state.state).toBe("entered");
    c.reveal();
    expect(c.state).toMatchObject({ value: privateValue, revealed: true });
    f.pause();
    const saving = c.submit();
    await Promise.resolve();
    await Promise.resolve();
    expect(c.state.state).toBe("saving");
    c.input("ignored");
    c.decline();
    c.reveal();
    expect(c.state).toMatchObject({ value: privateValue, revealed: true });
    f.finish();
    await saving;
    expect(await c.result).toEqual({ configured: true, name: "API" });
    expect(c.state.state).toBe("saved");
    expect(JSON.stringify(c.state)).not.toContain(privateValue);
    expect(f.writes).toHaveLength(1);
    c.input(privateValue);
    c.reveal();
    c.decline();
    await c.submit();
    expect(c.state.state).toBe("saved");
    expect(f.writes).toHaveLength(1);
  });
  test(`${code ? "code" : "chat"}: replacing and keeping a configured name, same saved row`, async () => {
    const f = fixture(code, { ...entry(), binding: code ? destination : { ...destination, pathPrefix: "/", prefix: "Bearer " } });
    await f.controller.start();
    expect(f.controller.state.state).toBe("replace");
    expect(f.controller.state.existing?.valueSetBy?.name).toBe("Lea Brandt");
    f.controller.input(privateValue);
    await f.controller.replace();
    expect(f.controller.state.state).toBe("saved");
    expect(f.writes[0]?.binding).toBeUndefined();
    const keeping = fixture(code, entry());
    await keeping.controller.start();
    keeping.controller.input(privateValue);
    keeping.controller.decline();
    expect(await keeping.controller.result).toEqual({ configured: false, name: "API" });
    expect(keeping.controller.state.state).toBe("declined");
    expect(JSON.stringify(keeping.controller.state)).not.toContain(privateValue);
  });
  test(`${code ? "code" : "chat"}: empty and invalid field; window lock and expired lease`, async () => {
    const f = fixture(code);
    await f.controller.start();
    await f.controller.submit();
    expect(f.controller.state.state).toBe("empty");
    f.controller.input("bad\n…");
    await f.controller.submit();
    expect(f.controller.state.state).toBe("characters");
    expect(f.writes).toHaveLength(0);
    f.controller.held();
    expect(f.controller.state.state).toBe("held");
    f.controller.input(privateValue);
    await f.controller.submit();
    f.controller.decline();
    expect(f.writes).toHaveLength(0);
    f.controller.complete({ configured: true, name: "API" });
    expect(f.controller.state.state).toBe("saved");
    const expired = fixture(code);
    await expired.controller.start();
    expired.controller.input(privateValue);
    expired.controller.expire();
    expect(expired.controller.state.state).toBe("expired");
    expect(await expired.controller.result).toMatchObject({ failed: true });
    expect(JSON.stringify(expired.controller.state)).not.toContain(privateValue);
  });
  test(`${code ? "code" : "chat"}: a conflict refreshes revision and replacement adopts the current target`, async () => {
    const f = fixture(code, entry());
    await f.controller.start();
    f.controller.input(privateValue);
    f.fail({ ok: false, code: "CONFLICT", status: 409 });
    const changed = { ...entry(), revision: "33333333-3333-4333-8333-333333333333", binding: { ...destination, pathPrefix: "/v2" } };
    f.setEntry(changed);
    await f.controller.replace();
    expect(f.controller.state.state).toBe("conflict");
    expect(f.calls.at(-1)).toBe("list");
    if (code) expect(f.controller.state.binding.pathPrefix).toBe("/v2");
    f.fail(null);
    await f.controller.replace();
    expect(f.writes.at(-1)?.revision).toBe(changed.revision);
    if (code) expect(f.writes.at(-1)?.binding).toBeUndefined();
    expect(f.controller.state.state).toBe("saved");
  });
}
test("chat preserves Latin-1 and 16000 character limit", async () => {
  const f = fixture();
  await f.controller.start();
  f.controller.input("a".repeat(16001));
  await f.controller.submit();
  expect(f.controller.state.state).toBe("too-long");
  f.controller.input("ä");
  await f.controller.submit();
  expect(f.controller.state.state).toBe("saved");
});
test("code permits only ASCII and deleted values reuse the binding revision", async () => {
  const f = fixture(true, entry(false));
  await f.controller.start();
  expect(f.controller.state.state).toBe("open");
  f.controller.input("ä");
  await f.controller.submit();
  expect(f.controller.state.state).toBe("characters");
  f.controller.input(privateValue);
  await f.controller.submit();
  expect(f.writes[0]?.revision).toBe(entry().revision);
  expect(f.writes[0]?.binding).toBeUndefined();
});
for (const code of ["FORBIDDEN", "NOT_FOUND"])
  test(`no card when list says ${code}`, async () => {
    const f = fixture(true);
    f.listFail({ ok: false, code, status: 403 });
    await f.controller.start();
    expect(f.controller.state).toMatchObject({ state: "unavailable", reason: "editor-required" });
    expect(f.calls).toEqual(["list"]);
    expect(await f.controller.result).toMatchObject({ failed: true, guidance: expect.stringContaining("edit this automation") });
  });
for (const allowed of [false, null])
  test(`no card when destination check says ${allowed}`, async () => {
    const f = fixture(true);
    f.allow(allowed);
    await f.controller.start();
    expect(f.controller.state).toMatchObject({ state: "unavailable", reason: allowed === false ? "destination-refused" : "check-failed" });
    expect(f.writes).toHaveLength(0);
  });
for (const code of [false, true])
  test(`${code ? "code" : "chat"}: lost rights close without guessing a reason`, async () => {
    const f = fixture(code);
    await f.controller.start();
    f.controller.input(privateValue);
    f.fail({ ok: false, code: "NOT_FOUND", status: 404 });
    await f.controller.submit();
    expect(f.controller.state.state).toBe("access-lost");
    expect(f.controller.state).not.toHaveProperty("value");
    expect(await f.controller.result).toMatchObject({ failed: true });
  });
for (const status of [400, 422, 500, null])
  test(`code failure ${status} preserves field, retry reads first`, async () => {
    const f = fixture(true);
    await f.controller.start();
    f.controller.input(privateValue);
    f.fail({ ok: false, code: status === 400 ? "BAD_INPUT" : "FAILED", status });
    await f.controller.submit();
    expect(f.controller.state.state).toBe(status === null || status >= 500 ? "no-answer" : "not-saved");
    expect(f.controller.state).toMatchObject({ value: privateValue });
    f.fail(null);
    const before = f.calls.length;
    await f.controller.retry();
    expect(f.calls[before]).toBe("list");
    expect(f.controller.state.state).toBe("saved");
  });

for (const [code, status, reason] of [
  ["BAD_INPUT", 400, "bad-input"],
  ["FAILED", 422, "rejected"],
] as const)
  test(`code failure ${code} has a stable reason for distinct card text`, async () => {
    const f = fixture(true);
    await f.controller.start();
    f.controller.input(privateValue);
    f.fail({ ok: false, code, status });
    await f.controller.submit();
    expect(f.controller.state).toMatchObject({ state: "not-saved", reason, value: privateValue });
    const state = f.controller.state;
    if (state.state !== "not-saved") throw new Error("Expected a rejected write");
    const { value: _fieldValue, ...facts } = state;
    expect(JSON.stringify(facts)).not.toContain(privateValue);
    f.controller.decline();
    expect(await f.controller.result).toEqual({ configured: false, name: "API" });
    expect(JSON.stringify(f.controller.state)).not.toContain(privateValue);
  });

for (const allowed of [false, null])
  test(`code destination recheck ${allowed} never sends the value and keeps its own failure reason`, async () => {
    const f = fixture(true);
    await f.controller.start();
    f.controller.input(privateValue);
    f.allow(allowed);
    await f.controller.submit();
    expect(f.controller.state).toMatchObject({ state: "not-saved", reason: allowed === false ? "destination-refused" : "check-failed" });
    expect(f.writes).toHaveLength(0);
    f.controller.expire();
    expect(JSON.stringify([await f.controller.result, f.controller.state])).not.toContain(privateValue);
  });

for (const code of [false, true])
  for (const writeFails of [false, true])
    test(`${code ? "code" : "chat"}: lease expiry during a pending write stays uncertain after late ${writeFails ? "failure" : "success"}`, async () => {
      const f = fixture(code);
      await f.controller.start();
      f.controller.input(privateValue);
      f.pause();
      if (writeFails) f.fail({ ok: false, code: "FAILED", status: 503 });
      const pending = f.controller.submit();
      await Promise.resolve();
      await Promise.resolve();
      expect(f.writes).toHaveLength(1);
      f.controller.expire();
      expect(f.controller.state.state).toBe("outcome-unknown");
      expect(f.controller.state).not.toHaveProperty("value");
      expect(await f.controller.result).toMatchObject({ failed: true, error: "Secret save outcome is unknown." });
      f.finish();
      await pending;
      f.controller.complete({ configured: true, name: "API" });
      f.controller.expire();
      await f.controller.retry();
      expect(f.controller.state.state).toBe("outcome-unknown");
      expect(f.writes).toHaveLength(1);
      expect(JSON.stringify([f.controller.state, await f.controller.result])).not.toContain(privateValue);
    });
test("lease expiry during the destination recheck ends as expired and never writes", async () => {
  let release!: (allowed: boolean) => void;
  let checks = 0;
  const writes: unknown[] = [];
  const controller = createSecretRequest(input(true), {
    list: async () => ({ ok: true, entry: null }),
    check: () => (checks++ === 0 ? Promise.resolve(true) : new Promise<boolean>((done) => (release = done))),
    save: async (value) => {
      writes.push(value);
      return { ok: true };
    },
  });
  await controller.start();
  controller.input(privateValue);
  const pending = controller.submit();
  await Promise.resolve();
  expect(controller.state.state).toBe("saving");
  controller.expire();
  release(true);
  await pending;
  expect(controller.state.state).toBe("expired");
  expect(await controller.result).toMatchObject({ failed: true, error: "Secret entry is no longer open. No entry was replayed." });
  expect(writes).toHaveLength(0);
  expect(JSON.stringify([controller.state, await controller.result])).not.toContain(privateValue);
});
test("an uncertain write followed by a stored value asks for replacement, never blindly retries", async () => {
  const f = fixture(true);
  await f.controller.start();
  f.controller.input(privateValue);
  f.fail({ ok: false, code: "FAILED", status: 503 });
  await f.controller.submit();
  f.setEntry(entry());
  await f.controller.retry();
  expect(f.controller.state.state).toBe("replace");
  expect(f.writes).toHaveLength(1);
});
test("a chat save failure retains only the window's value and retries with a fresh list", async () => {
  const f = fixture();
  await f.controller.start();
  f.controller.input(privateValue);
  f.fail({ ok: false, code: "FAILED", status: 500 });
  await f.controller.submit();
  expect(f.controller.state.state).toBe("save-failed");
  f.fail(null);
  await f.controller.retry();
  expect(f.controller.state.state).toBe("saved");
});
test("closing during a destination check never sends the value", async () => {
  const f = fixture(true);
  await f.controller.start();
  f.controller.input(privateValue);
  const pending = f.controller.submit();
  f.controller.expire();
  await pending;
  expect(f.writes).toHaveLength(0);
  expect(JSON.stringify(f.controller.state)).not.toContain(privateValue);
});

test("a failed list or check throws no private exception into a tool result", async () => {
  const c = createSecretRequest(input(true), {
    async list() {
      throw new Error(privateValue);
    },
    async check() {
      return true;
    },
    async save() {
      throw new Error(privateValue);
    },
  });
  await c.start();
  expect(c.state).toMatchObject({ state: "unavailable", reason: "list-failed" });
  expect(JSON.stringify(await c.result)).not.toContain(privateValue);
  const f = fixture(true);
  await f.controller.start();
  f.controller.input(privateValue);
  f.fail({ ok: false, code: "CONFLICT", status: 409 });
  f.listFail({ ok: false, code: "UNAVAILABLE", status: 503 });
  await f.controller.submit();
  expect(f.controller.state.state).toBe("no-answer");
  f.controller.expire();
});

test("binding is sent only for a new name or a changed destination", async () => {
  const initial = entry();
  initial.binding = { ...destination, pathPrefix: "/previous" };
  const f = fixture(true, initial);
  await f.controller.start();
  f.controller.input(privateValue);
  await f.controller.replace();
  expect(f.writes[0]?.binding).toEqual(destination);
});

test("window registry scopes controllers to chat, turn and call and removes them on cleanup", async () => {
  const { getSecretRequest, registerSecretRequest, observeSecretRequests } = await import("./secret-request");
  const key = { conversationId: "chat-1", turnId: "turn-1", callId: "call-1" };
  const f = fixture();
  let updates = 0;
  const stop = observeSecretRequests(() => updates++);
  const unregister = registerSecretRequest(key, f.controller);
  expect(getSecretRequest(key)).toBe(f.controller);
  expect(getSecretRequest({ ...key, conversationId: "chat-2" })).toBeUndefined();
  unregister();
  stop();
  expect(getSecretRequest(key)).toBeUndefined();
  expect(updates).toBe(2);
});

test("retry after a lost answer also adopts a concurrently changed destination", async () => {
  const f = fixture(true, entry());
  await f.controller.start();
  f.controller.input(privateValue);
  f.fail({ ok: false, code: "FAILED", status: 503 });
  await f.controller.replace();
  f.setEntry({ ...entry(), revision: "33333333-3333-4333-8333-333333333333", binding: { ...destination, pathPrefix: "/v2" } });
  await f.controller.retry();
  expect(f.controller.state.state).toBe("conflict");
  expect(f.controller.state.binding.pathPrefix).toBe("/v2");
  expect(f.writes).toHaveLength(1);
  f.fail(null);
  await f.controller.replace();
  expect(f.writes[1]?.binding).toBeUndefined();
});

// Published v4 has 33 scenes (its overview is not a state). Duplicate receipts intentionally share one state.
const scenes = [
  ["a-neu", false, "open"],
  ["a-tippt", false, "entered"],
  ["b-ersetzen", false, "replace"],
  ["speichert", false, "saving"],
  ["gespeichert", false, "saved"],
  ["b-ersetzt", false, "saved"],
  ["abgelehnt", false, "declined"],
  ["f-leer", false, "empty"],
  ["f-ungueltig", false, "characters"],
  ["f-recht", false, "access-lost"],
  ["f-speichern", false, "save-failed"],
  ["konflikt", false, "conflict"],
  ["anderswo", false, "held"],
  ["abgelaufen", false, "expired"],
  ["wartet", false, "open"],
  ["c-neu", true, "open"],
  ["c-tippt", true, "entered"],
  ["c-ersetzen", true, "replace"],
  ["c-speichert", true, "saving"],
  ["c-gespeichert", true, "saved"],
  ["c-ersetzt", true, "saved"],
  ["c-abgelehnt", true, "declined"],
  ["c-leer", true, "empty"],
  ["c-ungueltig", true, "characters"],
  ["c-nicht-verwaltet", true, "unavailable"],
  ["c-recht", true, "access-lost"],
  ["c-speichern", true, "not-saved"],
  ["c-unklar", true, "no-answer"],
  ["c-konflikt", true, "conflict"],
  ["c-geloescht", true, "open"],
  ["c-anderswo", true, "held"],
  ["c-abgelaufen", true, "expired"],
  ["c-wartet", true, "open"],
] as const;
for (const [scene, code, expected] of scenes)
  test(`mockup v4 ${scene}`, async () => {
    const replacing = ["b-ersetzen", "b-ersetzt", "c-ersetzen", "c-ersetzt"].includes(scene);
    const f = fixture(code, scene === "c-geloescht" ? entry(false) : replacing ? entry() : null);
    if (expected === "unavailable") f.listFail({ ok: false, code: "FORBIDDEN", status: 403 });
    await f.controller.start();
    if (["entered", "saving", "saved", "conflict", "save-failed", "not-saved", "no-answer", "access-lost"].includes(expected))
      f.controller.input(privateValue);
    if (expected === "characters") f.controller.input("…");
    if (expected === "held") f.controller.held();
    if (expected === "expired") f.controller.expire();
    if (expected === "declined") f.controller.decline();
    if (expected === "access-lost") f.fail({ ok: false, code: "NOT_FOUND", status: 404 });
    if (expected === "conflict") f.fail({ ok: false, code: "CONFLICT", status: 409 });
    if (["save-failed", "not-saved", "no-answer"].includes(expected))
      f.fail({ ok: false, code: "FAILED", status: expected === "not-saved" ? 422 : 503 });
    if (expected === "saving") {
      f.pause();
      const pending = f.controller.submit();
      await Promise.resolve();
      await Promise.resolve();
      expect(f.controller.state.state).toBe("saving");
      f.finish();
      await pending;
      return;
    }
    if (["saved", "empty", "characters", "conflict", "save-failed", "not-saved", "no-answer", "access-lost"].includes(expected))
      await (replacing ? f.controller.replace() : f.controller.submit());
    expect(f.controller.state.state).toBe(expected);
    f.controller.expire();
  });
