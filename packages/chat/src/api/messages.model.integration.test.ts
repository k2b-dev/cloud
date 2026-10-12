import { expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { ChatModel, type ModelOperation, randomOperation } from "../service/chat-model.test-fixture";
import { MessageViewSchema } from "../service/contracts";
import { type MessageRow, projectMessage } from "../service/message-store";
import { rng } from "../service/rng.test-fixture";
import { messageFixtures, type Person } from "./messages.test-fixture";

setDefaultTimeout(120_000);
const suite = suiteFor("database", "nats", "valkey");
const seedCount = Number(process.env.CHAT_MODEL_SEEDS ?? 8);
const opCount = Number(process.env.CHAT_MODEL_OPS ?? 40);
if (!Number.isSafeInteger(seedCount) || seedCount < 1 || !Number.isSafeInteger(opCount) || opCount < 1)
  throw new Error("CHAT_MODEL_SEEDS and CHAT_MODEL_OPS must be positive safe integers");
suite("chat HTTP state machine against the trimmed V5 oracle", () => {
  const f = messageFixtures();
  for (let seed = 1; seed <= seedCount; seed++)
    test(`seed ${seed}: ${opCount} operations`, async () => {
      const people: Person[] = [];
      for (let i = 0; i < 8; i++) people.push(await f.person(`Person ${i}`));
      const owner = people[0]!;
      const chat = await f.create(owner, people.slice(1, 4));
      const model = new ChatModel(new Map(people.map((p) => [p.id, p.name])));
      model.create(
        owner.id,
        people.slice(1, 4).map((p) => p.id),
      );
      const random = rng(seed);
      const responseIds = new Map<string, string>();
      const participants = () =>
        sql<
          { row: unknown }[]
        >`SELECT to_jsonb(p) AS row FROM chat.participants p WHERE conversation_id = ${chat.id}::uuid ORDER BY principal_id`;
      const entries = () =>
        sql<
          { user_id: string; access_id: string; permission: string }[]
        >`SELECT a.user_id, a.id AS access_id, a.permission FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id WHERE ca.conversation_id = ${chat.id}::uuid`;
      const perform = async (op: ModelOperation) => {
        const actor = people.find((p) => p.id === op.actor)!;
        const direct = await entries();
        const accessId = (id: string) => direct.find((row) => row.user_id === id)?.access_id ?? crypto.randomUUID();
        const path = `/${chat.shortId}`;
        switch (op.type) {
          case "send":
            return f.request(actor.headers, `${path}/messages`, "POST", { clientId: op.clientId, body: op.body });
          case "details":
            return f.request(actor.headers, path, "PATCH", op.details);
          case "add":
            return f.request(actor.headers, `${path}/members`, "POST", { members: op.members });
          case "permission":
            return f.request(actor.headers, `${path}/members/${accessId(op.member)}`, "PATCH", { permission: op.permission });
          case "remove":
            return f.request(actor.headers, `${path}/members/${accessId(op.member)}`, "DELETE");
          case "leave":
            return f.request(actor.headers, `${path}/leave`, "POST", op.successor ? { successor: accessId(op.successor) } : {});
        }
      };
      const check = async () => {
        const rows = await sql<MessageRow[]>`SELECT * FROM chat.messages WHERE conversation_id = ${chat.id}::uuid ORDER BY seq`;
        const projected = rows.map((row) => projectMessage(row, chat.shortId));
        expect(
          projected.map((m) => ({ seq: m.seq, rev: m.rev, kind: m.kind, author: m.author.id, body: m.body, system: m.system })),
        ).toEqual(model.msgs.map(({ seq, rev, kind, author, body, system }) => ({ seq, rev, kind, author, body, system })));
        expect(projected.map((m) => m.seq)).toEqual(Array.from({ length: model.seqHead }, (_, i) => i + 1));
        expect(new Set(projected.map((m) => m.rev)).size).toBe(projected.length);
        const [head] = await sql<
          {
            seq_head: string;
            rev: string;
            changed_rev: string;
            member_count: number;
            name: string | null;
            icon: string | null;
            purpose: string | null;
          }[]
        >`SELECT seq_head, rev, changed_rev, member_count, name, icon, purpose FROM chat.conversations WHERE id = ${chat.id}::uuid`;
        expect(Number(head!.rev)).toBe(model.rev);
        expect(Number(head!.seq_head)).toBe(model.seqHead);
        expect(Number(head!.changed_rev)).toBe(model.changedRev);
        expect(head!.member_count).toBe(model.members.size);
        expect(head!.name).toBe(model.name);
        expect(head!.icon).toBe(model.icon);
        expect(head!.purpose).toBe(model.purpose);
        expect(projected.every((m) => m.rev <= Number(head!.rev))).toBeTrue();
        const parts = await sql<
          { principal_id: string; joined_seq: string; last_read_seq: null }[]
        >`SELECT principal_id, joined_seq, last_read_seq FROM chat.participants WHERE conversation_id = ${chat.id}::uuid ORDER BY principal_id`;
        expect(parts.map((p) => ({ id: p.principal_id, joinedSeq: Number(p.joined_seq), lastReadSeq: p.last_read_seq }))).toEqual(
          [...model.parts].sort(([a], [b]) => a.localeCompare(b)).map(([id, p]) => ({ id, ...p })),
        );
        expect((await entries()).map((e) => [e.user_id, e.permission]).sort()).toEqual([...model.members].sort());
      };
      await check();
      for (let step = 0; step < opCount; step++) {
        const op = randomOperation(
          model,
          random,
          people.map((p) => p.id),
          step,
        );
        await f.resetSendLimits(people, chat.shortId);
        const before = await participants();
        const size = model.msgs.length;
        const expected = model.apply(op);
        const response = await perform(op);
        expect(response.status).not.toBe(500);
        if (expected) expect(response.ok).toBeTrue();
        if (op.type === "send") {
          expect(await participants()).toEqual(before);
          if (expected) {
            const message = MessageViewSchema.parse(await response.json());
            const key = `${op.actor}|${op.clientId}`;
            if (responseIds.has(key)) {
              expect(message.id).toBe(responseIds.get(key)!);
              expect(model.msgs.length).toBe(size);
              expect(response.status).toBe(200);
            } else {
              responseIds.set(key, message.id);
              expect(response.status).toBe(201);
            }
          } else expect([403, 404]).toContain(response.status);
        }
        try {
          await check();
        } catch (error) {
          throw new Error(`seed ${seed}, step ${step}, ${JSON.stringify(op)}`, { cause: error });
        }
      }
    });
});
