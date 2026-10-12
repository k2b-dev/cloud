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
