import { expect, test } from "bun:test";
import { ChatModel, randomOperation } from "./chat-model.test-fixture";
import { rng } from "./rng.test-fixture";

test("trimmed V5 model preserves numbering, retry and participant invariants", () => {
  const people = ["a", "b", "c", "d", "e"];
  for (let seed = 1; seed <= 64; seed++) {
    const model = new ChatModel(new Map(people.map((id) => [id, id])));
    model.create("a", ["b", "c"]);
    const random = rng(seed);
    for (let i = 0; i < 100; i++) {
      const op = randomOperation(model, random, people, i);
      const before = JSON.stringify([...model.parts]);
      const count = model.msgs.length;
      const retry = op.type === "send" ? model.byClientId.get(`${op.actor}|${op.clientId}`) : undefined;
      const result = model.apply(op);
      if (op.type === "send") expect(JSON.stringify([...model.parts])).toBe(before);
      if (retry && result) {
        expect(result.id).toBe(retry.id);
        expect(model.msgs.length).toBe(count);
      }
      expect(model.msgs.map((m) => m.seq)).toEqual(Array.from({ length: model.seqHead }, (_, i) => i + 1));
      expect(new Set(model.msgs.map((m) => m.rev)).size).toBe(model.msgs.length);
      expect(model.msgs.every((m) => m.rev <= model.rev)).toBeTrue();
    }
  }
});

test("V5 personal read state survives random reads, marks, opens, and sends", () => {
  const people = ["a", "b", "c", "group-reader"];
  for (let seed = 1; seed <= 64; seed++) {
    const model = new ChatModel(new Map(people.map((id) => [id, id])));
    model.create("a", ["b", "c"]);
    model.directory.add("group-reader");
    const random = rng(seed);
    for (let step = 0; step < 200; step++) {
      const op =
        step % 7 === 0
          ? { type: "read" as const, actor: "group-reader", seq: 1 + random.int(model.seqHead + 5) }
          : randomOperation(model, random, people, step);
      const before = new Map([...model.parts].map(([id, row]) => [id, { ...row }]));
      const ownUnread = model.unread(op.actor);
      const noRow = !model.parts.has(op.actor);
      const head = model.seqHead;
      model.apply(op);
      if (op.type === "send") {
        expect([...model.parts]).toEqual([...before]);
        expect(model.unread(op.actor)).toBe(ownUnread);
      }
      for (const [id, row] of model.parts) {
        expect(model.unread(id)).toBeGreaterThanOrEqual(0);
        expect(model.unread(id)).toBeLessThanOrEqual(100);
        if (before.has(id) && op.type !== "add") expect(row.lastReadSeq ?? 0).toBeGreaterThanOrEqual(before.get(id)!.lastReadSeq ?? 0);
        if (op.type === "markUnread") expect(row.lastReadSeq).toBe(before.get(id)?.lastReadSeq ?? null);
      }
      if (!model.parts.has("group-reader")) {
        expect(model.unread("group-reader")).toBe(0);
        expect(model.start("group-reader")).toBeNull();
      }
      if (noRow && op.type === "read" && model.canRead(op.actor))
        expect(model.parts.get(op.actor)).toMatchObject({
          joinedSeq: Math.min(op.seq, head),
          lastReadSeq: Math.min(op.seq, head),
          origin: "ondemand",
        });
    }
  }
});

test("no-row readers start at the first read seq or opening head, and unread is capped", () => {
  const model = new ChatModel(
    new Map([
      ["a", "A"],
      ["b", "B"],
      ["g", "G"],
      ["h", "H"],
    ]),
  );
  model.create("a", ["b"]);
  model.directory.add("g");
  model.directory.add("h");
  for (let i = 0; i < 150; i++) model.apply({ type: "send", actor: "a", clientId: String(i), body: "text" });
  expect(model.unread("b")).toBe(100);
  expect(model.unread("g")).toBe(0);
  model.read("g", 100);
  expect(model.parts.get("g")?.joinedSeq).toBe(100);
  expect(model.unread("g")).toBe(51);
  model.open("h");
  expect(model.parts.get("h")).toMatchObject({ joinedSeq: 151, lastReadSeq: null });
  expect(model.unread("h")).toBe(0);
  model.read("b", 151);
  model.markUnread("b", 80);
  model.read("b", 100);
  expect(model.parts.get("b")).toMatchObject({ lastReadSeq: 151, unreadFromSeq: 101 });
  model.read("b", 151);
  expect(model.parts.get("b")?.unreadFromSeq).toBeNull();
});
