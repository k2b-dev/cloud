import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { type SQLQuery, sql } from "bun";
import { boundConversation, type ChatContext, capPermission, messages, readableMemberCondition, subjectPrincipal } from "./access";
import { conversationSearchTitle, conversations } from "./conversations";
import { type ResourceReaderDependencies, readContainers, readerBatch, readResource, resourceReaderDependencies } from "./resource-access";
import { SEARCH_LIMIT, type SearchHit, SearchQuerySchema, type SearchResult } from "./search-contracts";
import { nameMatchRank, rankSearchCandidates, type SearchCandidate } from "./search-ranking";
import { READER_REQUEST_BUDGET, SUMMARY_TRAVERSAL_BUDGET } from "./thread-access";

const run = async <T>(query: SQLQuery<T>, signal?: AbortSignal): Promise<T> => {
  const cancel = () => query.cancel();
  try {
    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancel, { once: true });
    const rows = await query;
    signal?.throwIfAborted();
    return rows;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
};
type Candidate = SearchCandidate<SearchHit>;
type OrdinaryRow = {
  kind: "chat" | "thread";
  conversation_id: string;
  title: string;
  thread_id: string | null;
  name: string;
  archived: boolean;
  activity: Date;
};
const ordinary = (context: ChatContext, q: string, bound: string | null): Promise<Candidate[]> =>
  sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const self = subjectPrincipal(context.accessSubject);
    const wordPattern = `(^|[^[:alnum:]_])${q.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    const rows = await run(
      db<OrdinaryRow[]>`WITH member_conversations AS MATERIALIZED (
        SELECT c.id, c.short_id, ${conversationSearchTitle(context, db)} AS title,
          c.last_activity_at, (p.archived_at IS NOT NULL) AS archived
        FROM chat.conversations c
        LEFT JOIN chat.participants p ON p.conversation_id = c.id
          AND p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid
        WHERE EXISTS (SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
          WHERE ca.conversation_id = c.id AND ${readableMemberCondition(context.accessSubject, bound, db)})
      ), candidates AS (
        SELECT 'chat' AS kind, c.short_id AS conversation_id, c.title, NULL::text AS thread_id,
          c.title AS name, c.archived, c.last_activity_at AS activity FROM member_conversations c
        UNION ALL
        SELECT 'thread', c.short_id, c.title, t.short_id, t.name, c.archived, t.last_activity_at
        FROM member_conversations c JOIN chat.threads t ON t.conversation_id = c.id
        WHERE t.archived_at IS NULL AND t.resource_type IS NULL
      ) SELECT * FROM candidates WHERE strpos(lower(name), lower(${q})) > 0
      ORDER BY archived,
        CASE WHEN lower(name) = lower(${q}) THEN 0 WHEN starts_with(lower(name), lower(${q})) THEN 1
          WHEN lower(name) ~ ${wordPattern} THEN 2 ELSE 3 END,
        activity DESC, conversation_id, thread_id NULLS FIRST LIMIT ${SEARCH_LIMIT}`,
      context.caller?.signal,
    );
    const candidates: Candidate[] = [];
    for (const row of rows) {
      context.caller?.signal?.throwIfAborted();
      let hit: SearchHit;
      if (row.kind === "chat") {
        const result = await conversations.get({ ...context, conversationId: row.conversation_id }, db);
        if (!result.ok) continue;
        hit = { kind: "chat", conversation: result.data };
      } else {
        if (!row.thread_id) continue;
        hit = {
          kind: "thread",
          conversation: { id: row.conversation_id, title: row.title, kind: "chat" },
          thread: { id: row.thread_id, name: row.name },
        };
      }
      candidates.push({
        hit,
        name: row.name,
        archived: row.archived,
        activity: row.activity.toISOString(),
        key: `${row.conversation_id}:${row.thread_id ?? ""}`,
      });
    }
    return candidates;
  });

type SystemThreadRow = {
  conversation_id: string;
  resource_type: string;
  resource_id: string;
  thread_id: string;
  item_type: string;
  item_id: string;
  activity: Date;
};
const system = async (context: ChatContext, q: string, bound: string | null) => {
  let unavailable = false;
  const onUnavailable = () => {
    unavailable = true;
  };
  // Reserve the two existing summary container reads for each possible output hit.
  let remaining = READER_REQUEST_BUDGET - 2 * SEARCH_LIMIT;
  const dependencies: ResourceReaderDependencies = {
    invoke: async (...args) => {
      context.caller?.signal?.throwIfAborted();
      if (remaining <= 0) throw new Error("Search reader budget exhausted");
      remaining--;
      return resourceReaderDependencies.invoke(...args);
    },
  };
  const read = (type: string, id: string) => readResource(context, { type, id }, dependencies, onUnavailable);
  const candidates: Candidate[] = [];
  const scope = { "spaces.space": new Set<string>(), "notebooks.notebook": new Set<string>() };
  const conversationIds = new Map<string, string>();
  // A failure in one owner leaves the other owner and ordinary results usable.
  for (const type of ["spaces.space", "notebooks.notebook"] as const) {
    context.caller?.signal?.throwIfAborted();
    try {
      const page = await readContainers(context, type, undefined, dependencies, q);
      const directory = await readContainers(context, type, undefined, dependencies);
      for (const entry of [...page.items, ...directory.items]) scope[type].add(entry.ref.id);
      for (const entry of page.items) {
        context.caller?.signal?.throwIfAborted();
        if (nameMatchRank(entry.name, q) === null) continue;
        const [row] = await run(
          sql<{ short_id: string; activity: Date }[]>`SELECT c.short_id, COALESCE((SELECT m.created_at FROM chat.messages m
            WHERE m.conversation_id = c.id AND m.thread_id IS NULL AND m.kind = 'text' ORDER BY m.seq DESC LIMIT 1), c.created_at) AS activity
          FROM chat.conversations c WHERE kind = 'system' AND resource_type = ${type} AND resource_id = ${entry.ref.id}`,
          context.caller?.signal,
        );
        if (bound !== null && row?.short_id !== bound) continue;
        const key = `${type}:${entry.ref.id}`;
        if (row) conversationIds.set(key, row.short_id);
        candidates.push({
          hit: { kind: "system", ref: entry.ref, name: entry.name, conversation: null },
          name: entry.name,
          archived: false,
          activity: row?.activity.toISOString() ?? "",
          key,
        });
      }
    } catch {
      context.caller?.signal?.throwIfAborted();
      unavailable = true;
    }
  }
  // Stored item names are snapshots. Read current names on a single directory-sized page.
  const rows = await run(
    sql<SystemThreadRow[]>`SELECT c.short_id AS conversation_id, c.resource_type, c.resource_id,
      t.short_id AS thread_id, t.resource_type AS item_type, t.resource_id AS item_id, t.last_activity_at AS activity
    FROM chat.threads t JOIN chat.conversations c ON c.id = t.conversation_id
    WHERE c.kind = 'system' AND (
      (c.resource_type = 'spaces.space' AND c.resource_id = ANY(${toPgTextArray([...scope["spaces.space"]])}::text[])) OR
      (c.resource_type = 'notebooks.notebook' AND c.resource_id = ANY(${toPgTextArray([...scope["notebooks.notebook"]])}::text[]))
    ) AND t.archived_at IS NULL AND t.resource_type IS NOT NULL AND t.resource_id IS NOT NULL
      AND ${bound ? sql`c.short_id = ${bound}` : sql`true`}
    ORDER BY t.last_activity_at DESC, t.short_id LIMIT ${SUMMARY_TRAVERSAL_BUDGET}`,
    context.caller?.signal,
  );
  // Finish container authorization before starting the bounded item-reader batches.
  const containers = await readerBatch(
    rows,
    async (row) => ({ row, container: await read(row.resource_type, row.resource_id) }),
    context.caller?.signal,
  );
  const visible = containers.filter(({ container }) => container && capPermission(container.permission, context.actor) !== "none");
  const items = await readerBatch(
    visible,
    async ({ row, container }) => ({ row, container, resource: await read(row.item_type, row.item_id) }),
    context.caller?.signal,
  );
  for (const { row, container, resource } of items) {
    context.caller?.signal?.throwIfAborted();
    if (!container || !resource?.kind || resource.container?.type !== row.resource_type || resource.container.id !== row.resource_id)
      continue;
    const parent = candidates.find((candidate) => candidate.key === `${row.resource_type}:${row.resource_id}`);
    if (parent && parent.activity < row.activity.toISOString()) parent.activity = row.activity.toISOString();
    candidates.push({
      hit: {
        kind: "thread",
        conversation: { id: row.conversation_id, title: container.name, kind: "system" },
        thread: { id: row.thread_id, name: resource.name, resource: { kind: resource.kind, done: resource.done } },
      },
      name: resource.name,
      archived: false,
      activity: row.activity.toISOString(),
      key: `${row.conversation_id}:${row.thread_id}`,
    });
  }
  return {
    candidates,
    conversationIds,
    read,
    get unavailable() {
      return unavailable;
    },
  };
};

export const search = async (input: ChatContext & { query: unknown }): Promise<Result<SearchResult>> => {
  const parsed = SearchQuerySchema.safeParse(input.query);
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const bound = boundConversation(input.actor, input.locale);
  if (!bound.ok) return bound;
  input.caller?.signal?.throwIfAborted();
  if (capPermission("read", input.actor) === "none") return ok({ items: [] });
  const [personal, resources] = await Promise.all([ordinary(input, parsed.data.q, bound.data), system(input, parsed.data.q, bound.data)]);
  const candidates = [...personal, ...resources.candidates];
  const ranked = rankSearchCandidates(candidates, parsed.data.q, candidates.length);
  const items: SearchHit[] = [];
  for (const hit of ranked) {
    input.caller?.signal?.throwIfAborted();
    if (items.length === SEARCH_LIMIT) break;
    if (hit.kind === "system") {
      const resource = await resources.read(hit.ref.type, hit.ref.id);
      if (!resource || capPermission(resource.permission, input.actor) === "none") continue;
      const id = resources.conversationIds.get(`${hit.ref.type}:${hit.ref.id}`);
      if (id) {
        // Search spends its item-reader budget on matching; summaries explicitly remain partial.
        const result = await conversations.get({ ...input, conversationId: id, threadBudget: { remaining: 0 } });
        if (!result.ok) continue;
        hit.conversation = result.data;
      }
    }
    items.push(hit);
  }
  input.caller?.signal?.throwIfAborted();
  return ok({ items, ...(resources.unavailable ? { systemUnavailable: true as const } : {}) });
};
