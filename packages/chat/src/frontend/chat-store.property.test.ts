import { expect, test } from "bun:test";
import type { LiveConnection, LiveSubscriptionHandlers } from "@k2b/cloud/browser/live";
import type { z } from "zod";
import { ChatModel, type ModelUpdate } from "../service/chat-model.test-fixture";
import { type ChatLiveEventSchema, ConversationSchema } from "../service/contracts";
import { rng } from "../service/rng.test-fixture";
import { type ChatStoreApi, createChatStore } from "./chat-store";

const unusedMemberRequest = async () => {
  throw new Error("Unused member request");
};
const memberApi = {
  create: unusedMemberRequest,
  updateDetails: unusedMemberRequest,
  members: unusedMemberRequest,
  previewMembers: unusedMemberRequest,
  addMembers: unusedMemberRequest,
  updateMember: unusedMemberRequest,
  removeMember: unusedMemberRequest,
  leave: unusedMemberRequest,
  people: unusedMemberRequest,
};

class ManualConnection implements LiveConnection {
  channels = new Map<string, (data: unknown) => Promise<void>>();
  subscribe<T>(channel: string, _scope: unknown, handlers: LiveSubscriptionHandlers<T>) {
    this.channels.set(channel, async (data) => {
      handlers.caughtUp?.(false);
      await handlers.apply([{ data: handlers.parse(data), cursor: "cursor" }]);
      handlers.caughtUp?.(true);
    });
    handlers.caughtUp?.(true);
    return { close() {} };
  }
  apply(channel: string, data: unknown) {
    const apply = this.channels.get(channel);
    if (!apply) throw new Error("Missing channel");
    return apply(data);
  }
}
const viewerId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const cid = "abcdef";
const date = (rev: number) => new Date(Date.UTC(2026, 9, 12) + rev).toISOString();

test("real store converges to V5 under per-key FIFO, random cross-key order, duplicates, and snapshot overlap", async () => {
  for (let seed = 1; seed <= 96; seed++) {
    const random = rng(seed);
    const model = new ChatModel(
      new Map([
        [viewerId, "Viewer"],
        [otherId, "Other"],
      ]),
    );
    model.create(otherId, [viewerId]);
    if (seed % 3 === 0) {
      model.members.delete(viewerId);
      model.parts.delete(viewerId);
      model.directory.add(viewerId);
    }
    const row = () => {
      const part = model.parts.get(viewerId);
      const latest = model.msgs.findLast((m) => m.kind === "text");
      return ConversationSchema.parse({
        id: cid,
        name: null,
        icon: null,
        purpose: null,
        title: "Other",
        memberCount: 2,
        archived: false,
        pinnedRank: null,
        member: true,
        withGuests: false,
        peerDeactivated: false,
        rev: model.rev,
        permission: "write",
        createdAt: date(0),
        lastActivityAt: date(latest?.rev ?? 0),
        lastMessage: latest
          ? {
              id: String(latest.seq).padStart(10, "0"),
              author: { type: "user", id: latest.author, name: "Author" },
              preview: latest.body,
              createdAt: date(latest.rev),
            }
          : null,
        read: part ? { lastReadSeq: part.lastReadSeq, unreadFromSeq: part.unreadFromSeq, joinedSeq: part.joinedSeq } : null,
        unread: model.unread(viewerId),
      });
    };
    const connection = new ManualConnection();
    const api: ChatStoreApi = {
      ...memberApi,
      personal: async () => {
        throw new Error("Unused personal write");
      },
      preferences: async () => ({ collapsed: [] }),
      savePreferences: async (collapsed) => ({ collapsed }),
      conversations: async () => ({ items: [row()], nextCursor: null }),
      conversation: async () => row(),
      messages: async () => null,
      snapshot: async () => null,
      changes: async () => null,
      read: async () => {
        throw new Error("Unused write");
      },
      markUnread: async () => {
        throw new Error("Unused write");
      },
      readAll: async () => {
        throw new Error("Unused write");
      },
    };
    const store = createChatStore({ viewerId, cursor: "cursor", sidebar: { items: [row()], nextCursor: null } }, { api, connection });
    const queues = new Map<string, z.infer<typeof ChatLiveEventSchema>[]>();
    const enqueue = (updates: ModelUpdate[]) => {
      for (const update of updates) {
        let event: z.infer<typeof ChatLiveEventSchema>;
        let key: string;
        if (update.key === "p") {
          if (update.principal !== viewerId) continue;
          key = "me";
          event = { type: "read", conversationId: cid, ...update.read, unread: update.unread, asOfRev: update.asOfRev };
        } else {
          const m = update.message;
          key = "list";
          event = {
            type: "summary",
            conversationId: cid,
            id: String(m.seq).padStart(10, "0"),
            seq: m.seq,
            rev: m.rev,
            kind: m.kind,
            author: { type: "user", id: m.author, name: "Author" },
            preview: m.body,
            createdAt: date(m.rev),
            mention: false,
          };
        }
        const queue = queues.get(key) ?? [];
        queue.push(event);
        if (random.int(3) === 0) queue.push(event);
        queues.set(key, queue);
      }
    };
    enqueue(model.outbox);
    for (let step = 0; step < 80; step++) {
      // Several transactions commit before delivery, so a row refetch covers still-queued summaries.
      for (let i = 0; i < 4 + random.int(5); i++) {
        switch (random.int(6)) {
          case 0:
            model.apply({ type: "read", actor: viewerId, seq: 1 + random.int(model.seqHead + 3) });
            break;
          case 1:
            model.apply({
              type: "markUnread",
              actor: viewerId,
              ...(random.int(2) ? { message: 1 + random.int(Math.max(1, model.seqHead)) } : {}),
            });
            break;
          case 2:
            model.apply({ type: "readAll", actor: viewerId });
            break;
          case 3:
            model.apply({ type: "details", actor: otherId, details: { name: `Chat ${step}-${i}` } });
            break;
          default:
            model.apply({ type: "send", actor: random.int(3) ? otherId : viewerId, clientId: `${step}-${i}`, body: "text" });
        }
        enqueue(model.outbox);
      }
      while (queues.size) {
        const key = random.pick([...queues.keys()])!;
        const queue = queues.get(key)!;
        await connection.apply(key, queue.shift()!);
        if (!queue.length) queues.delete(key);
      }
      try {
        expect(store.sidebar[0]?.unread).toBe(model.unread(viewerId));
        expect(store.sidebar[0]?.read).toEqual(row().read);
      } catch (error) {
        throw new Error(`seed ${seed}, step ${step}`, { cause: error });
      }
    }
    store.dispose();
  }
});
