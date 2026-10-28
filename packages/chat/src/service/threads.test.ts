import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { UserSchema } from "@k2b/cloud/contracts";
import type { sql } from "bun";
import * as access from "./access";
import { MAX_THREADS } from "./contracts";
import * as messageStore from "./message-store";
import * as threadAccess from "./thread-access";
import * as threadState from "./thread-state";
import { type ThreadRow, threads } from "./threads";

const userId = "11111111-1111-4111-8111-111111111111";
const context: access.ChatContext = {
  actor: {
    kind: "user",
    user: UserSchema.parse({
      id: userId,
      uid: "lea",
      provider: "local",
      profile: "user",
      roles: ["user"],
      givenname: "Lea",
      sn: "Example",
      displayName: "Lea",
      mail: null,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    }),
  },
  accessSubject: { type: "user", userId },
};
const at = new Date("2026-10-24T12:00:00Z");
afterEach(() => mock.restore());

for (const selectedOld of [true, false])
  test(`short refresh bounds candidates before unread SQL, selected ${selectedOld ? "old" : "recent"}`, async () => {
    const rows: (ThreadRow & { recent: boolean })[] = Array.from({ length: MAX_THREADS }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      short_id: i === 0 ? "OldOne" : `T${String(i).padStart(5, "0")}`,
      recent: selectedOld ? i >= 1 && i <= 4 : i < 4,
      resource_type: null,
      resource_id: null,
      name: `Thread ${i}`,
      description: null,
      archived_at: null,
      created_at: at,
      last_activity_at: selectedOld && i === 0 ? new Date("2020-01-01T00:00:00Z") : at,
    }));
    spyOn(access, "requireConversation").mockResolvedValue({
      ok: true,
      data: {
        id: userId,
        short_id: "Chat01",
        kind: "system",
        resource_type: "spaces.space",
        resource_id: "Space1",
        name: null,
        icon: null,
        purpose: null,
        member_count: 0,
        seq_head: "0",
        rev: "1",
        changed_rev: "1",
        created_at: at,
        last_activity_at: at,
        permission: "read",
      },
    });
    spyOn(threadAccess, "visibleThreadPage").mockImplementation(async (_context, candidates) =>
      candidates.map((row) => ({ row, resource: null })),
    );
    const states = spyOn(threadState, "threadStates").mockImplementation((_db, _subject, _id, ids) => {
      const result: threadState.ThreadState[] = [null, ...(ids ?? rows.map((row) => row.id))].map((id) => ({
        id,
        short_id: rows.find((row) => row.id === id)?.short_id ?? null,
        last_read_seq: null,
        unread_from_seq: null,
        joined_seq: "0",
        unread: id === rows[8]!.id ? 1 : 0,
        first_unread_seq: null,
      }));
      return Promise.resolve(result) as ReturnType<typeof threadState.threadStates>;
    });
    spyOn(messageStore, "messageViews").mockResolvedValue([]);
    const queries: { text: string; values: unknown[] }[] = [];
    const fragments: string[] = [];
    // A lazy SQL-tag double: interpolation builds fragments; only awaited queries execute.
    const db = ((parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join("?");
      fragments.push(text);
      return {
        then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => {
          queries.push({ text, values });
          return Promise.resolve(text.includes("SELECT kind") ? [{ kind: "system" }] : text.includes("SELECT *,") ? rows : []).then(
            resolve,
            reject,
          );
        },
      };
    }) as unknown as typeof sql;
    const result = await threads.list({ ...context, conversationId: "Chat01", query: { short: "true", selected: "OldOne" } }, db);
    expect(result.ok).toBe(true);
    // No directory-wide state query may hide inside the bounded candidate query.
    expect(states.mock.calls.length).toBeGreaterThan(0);
    for (const call of states.mock.calls) {
      expect(call[3]).toBeDefined();
      expect(call[3]!.length).toBeLessThanOrEqual(MAX_THREADS);
    }
    const candidates = queries.find((query) => query.text.includes("SELECT *,"))!;
    expect(fragments.join(" ")).toContain("last_activity_at DESC");
    expect(fragments.join(" ")).toContain("short_id =");
    expect(candidates.values.at(-1)).toBe(MAX_THREADS);
    if (!result.ok) throw new Error("Expected an authorized list");
    expect(result.data.items.map((row) => row.id)).toEqual(
      selectedOld ? ["OldOne", "T00001", "T00002", "T00003", "T00004", "T00008"] : ["OldOne", "T00001", "T00002", "T00003", "T00008"],
    );
    expect(result.data.nextCursor).toBeNull();
  });
