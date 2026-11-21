import { request } from "node:http";
import { z } from "zod";
import type { JmapMailboxRights } from "./jmap";
import { JMAP_CORE, JMAP_MAIL, JMAP_SUBMISSION, type JmapInvocation } from "./jmap-client";
import { JMAP_EMAIL_PROPERTIES, type JmapEmailSnapshot, jmapEmailSnapshotSchema } from "./jmap-email";
import type { JmapTransportDependencies } from "./jmap-transport";

export const fixtureRights: JmapMailboxRights = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
};
export const fixtureMailbox = (id: string, name: string, parentId: string | null = null, role: string | null = null) => ({
  id,
  name,
  parentId,
  role,
  isSubscribed: true,
  myRights: { ...fixtureRights, mayShare: true, maySetMetadata: true },
});

export const fixtureEmail = (id: string): JmapEmailSnapshot =>
  jmapEmailSnapshotSchema.parse({
    id,
    blobId: `blob-${id}`,
    threadId: `thread-${id}`,
    mailboxIds: { a: true },
    keywords: {},
    size: 326,
    receivedAt: "2026-11-19T10:00:00Z",
    sentAt: null,
    subject: "Example",
    from: [{ name: "Example", email: "sender@example.invalid" }],
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    messageId: [`${id}@example.invalid`],
    inReplyTo: [],
    references: [],
    hasAttachment: false,
    bodyStructure: {
      partId: "1",
      type: "text/plain",
      charset: "utf-8",
      name: null,
      cid: null,
      disposition: null,
      size: 10,
      subParts: null,
    },
    ...Object.fromEntries(JMAP_EMAIL_PROPERTIES.filter((key) => key.startsWith("header:")).map((key) => [key, null])),
  });

function selectBodyProperties(part: JmapEmailSnapshot["bodyStructure"], properties: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(part)
      .filter(([key]) => properties.includes(key))
      .map(([key, value]) => [
        key,
        key === "subParts" ? (part.subParts?.map((child) => selectBodyProperties(child, properties)) ?? null) : value,
      ]),
  );
}

type FixtureChange = { id: string; kind: "created" | "updated" | "destroyed" };
type FixtureType = "Email" | "Mailbox";

/** HTTP exists only behind the injected request factory; production URL validation stays HTTPS-only. */
export function createJmapFixture() {
  const origin = "https://mail.example.invalid";
  const session = {
    capabilities: {
      [JMAP_CORE]: {
        maxSizeUpload: 50_000_000,
        maxConcurrentUpload: 4,
        maxSizeRequest: 10_000_000,
        maxConcurrentRequests: 4,
        maxCallsInRequest: 16,
        maxObjectsInGet: 2,
        maxObjectsInSet: 500,
        collationAlgorithms: ["i;unicode-casemap"],
      },
      [JMAP_MAIL]: {},
      [JMAP_SUBMISSION]: {},
    },
    accounts: {
      d333333: {
        name: "Example mailbox",
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: { [JMAP_MAIL]: { maxSizeMailboxName: 1_000 }, [JMAP_SUBMISSION]: {} },
      },
    },
    primaryAccounts: { [JMAP_MAIL]: "d333333" },
    username: "reader@example.invalid",
    apiUrl: "/jmap/",
    downloadUrl: "/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
    uploadUrl: "/jmap/upload/{accountId}/",
    eventSourceUrl: "/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
    state: "session-state",
  };
  const requests: Array<{ path: string; method: string; authorization: string | null; calls?: JmapInvocation[] }> = [];
  const mailboxes = [fixtureMailbox("a", "Inbox", null, "inbox"), fixtureMailbox("b", "Projects"), fixtureMailbox("c", "Example", "b")];
  const emails: JmapEmailSnapshot[] = [];
  const blobs = new Map<string, Uint8Array[]>();
  const download: {
    status?: number;
    contentLength?: number;
    afterChunk?: (index: number) => Promise<void>;
    cancelled: number;
  } = { cancelled: 0 };
  const journal: Record<FixtureType, FixtureChange[]> = { Email: [], Mailbox: [] };
  const state = (type: FixtureType, position = journal[type].length) => `${type}:${position}`;
  const changes = (type: FixtureType, args: Record<string, unknown>): Record<string, unknown> => {
    const start = Array.from({ length: journal[type].length + 1 }, (_, index) => state(type, index)).indexOf(String(args.sinceState));
    if (start < 0) return { type: "invalidArguments" };
    const limit = z.number().int().positive().parse(args.maxChanges);
    let net = new Map<string, FixtureChange["kind"]>();
    let end = start;
    for (const event of journal[type].slice(start)) {
      const next = new Map(net);
      if (event.kind === "destroyed" && next.get(event.id) === "created") next.delete(event.id);
      else if (next.get(event.id) !== "created" || event.kind !== "updated") next.set(event.id, event.kind);
      if (next.size > limit) break;
      net = next;
      end++;
    }
    const ids = (kind: FixtureChange["kind"]) => [...net].filter(([, value]) => value === kind).map(([id]) => id);
    return {
      accountId: "d333333",
      oldState: state(type, start),
      newState: state(type, end),
      hasMoreChanges: end < journal[type].length,
      created: ids("created"),
      updated: ids("updated"),
      destroyed: ids("destroyed"),
      ...(type === "Mailbox" ? { updatedProperties: controls.updatedProperties } : {}),
    };
  };
  // Newest receivedAt first unless isAscending; ties ordered by ID. RFC 8621 §4.4.1: before is exclusive, after inclusive.
  const emailQuery = (args: Record<string, unknown>): Record<string, unknown> => {
    const filter = z.object({ before: z.string().optional(), after: z.string().optional() }).strict().nullish().safeParse(args.filter);
    if (!filter.success) return { type: "unsupportedFilter" };
    const sort = z
      .array(z.object({ property: z.string(), isAscending: z.boolean().optional() }))
      .optional()
      .parse(args.sort);
    if (sort?.some((comparator) => comparator.property !== "receivedAt")) return { type: "unsupportedSort" };
    const direction = sort?.[0]?.isAscending === true ? 1 : -1;
    const time = (value: string) => Date.parse(value);
    const { before, after } = filter.data ?? {};
    const ids = emails
      .filter(
        (email) =>
          (before === undefined || time(email.receivedAt) < time(before)) && (after === undefined || time(email.receivedAt) >= time(after)),
      )
      .sort((a, b) => direction * (time(a.receivedAt) - time(b.receivedAt)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((email) => email.id);
    const position = z.number().int().nonnegative().optional().parse(args.position) ?? 0;
    const requested = z.number().int().positive().optional().parse(args.limit);
    const cap = controls.emailQueryLimit;
    const limit = cap !== undefined && (requested === undefined || cap < requested) ? cap : requested;
    return {
      accountId: "d333333",
      // Changes exactly when this query's complete result list changes.
      queryState: `query-${Bun.hash(ids.join(",")).toString(36)}`,
      canCalculateChanges: false,
      position,
      ids: ids.slice(position, limit === undefined ? undefined : position + limit),
      ...(args.calculateTotal === true ? { total: ids.length } : {}),
      ...(limit !== requested ? { limit } : {}),
    };
  };
  const methodErrors = new Map<string, string>(); // Call ID -> method error, independent of sibling calls.
  const controls: {
    redirect: string | null;
    status: number | null;
    apiStatus: number | null;
    methodError: string | null;
    oversized: boolean;
    abort: boolean;
    updatedProperties: string[] | null;
    getState?: string;
    /** A server-side cap below the requested Email/query limit. */
    emailQueryLimit?: number;
    afterChanges?: (type: FixtureType) => void;
    /** Runs between Email/query and a get in the same request, to stage races deterministically. */
    afterEmailQuery?: () => void;
    transform?: (response: JmapInvocation) => JmapInvocation;
    handle?: (request: Request) => Response | undefined | Promise<Response | undefined>;
  } = { redirect: null, status: null, apiStatus: null, methodError: null, oversized: false, abort: false, updatedProperties: null };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const entry: (typeof requests)[number] = { path, method: req.method, authorization: req.headers.get("authorization") };
      requests.push(entry);
      const custom = await controls.handle?.(req);
      if (custom) return custom;
      if (controls.abort) {
        server.stop(true);
        return new Response();
      }
      if (controls.oversized) return new Response("x".repeat(256 * 1024 + 1));
      if (controls.status !== null)
        return new Response(controls.status === 200 ? "{}" : "", {
          status: controls.status,
          headers: { location: controls.redirect ?? "/jmap/session", "retry-after": "30" },
        });
      if (path === "/.well-known/jmap" && controls.redirect)
        return new Response(null, { status: 307, headers: { location: controls.redirect } });
      if (path.startsWith("/jmap/download/")) {
        const blobId = path.split("/")[4];
        const chunks = blobId ? blobs.get(decodeURIComponent(blobId)) : undefined;
        const status = download.status ?? (chunks ? 200 : 404);
        if (status !== 200) return new Response("", { status, headers: { location: "/elsewhere", "retry-after": "30" } });
        let index = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              const chunk = chunks?.[index];
              if (!chunk) {
                controller.close();
                return;
              }
              controller.enqueue(chunk);
              const sent = index++;
              await download.afterChunk?.(sent);
            },
            cancel() {
              download.cancelled++;
            },
          }),
          { headers: download.contentLength === undefined ? {} : { "content-length": String(download.contentLength) } },
        );
      }
      if (req.method === "GET")
        return Response.json(req.headers.has("authorization") ? session : { ...session, accounts: {}, primaryAccounts: {} });
      if (controls.apiStatus !== null)
        return new Response(JSON.stringify({ type: "urn:ietf:params:jmap:error:limit" }), {
          status: controls.apiStatus,
          headers: { "retry-after": "30" },
        });
      const body = z
        .object({ methodCalls: z.array(z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()])) })
        .parse(await req.json());
      entry.calls = body.methodCalls;
      const methodResponses: JmapInvocation[] = [];
      const invoke = ([name, args, id]: JmapInvocation): JmapInvocation => {
        const methodError = methodErrors.get(id) ?? methodErrors.get(name) ?? controls.methodError;
        if (methodError) return ["error", { type: methodError }, id];
        if (name === "Email/changes" || name === "Mailbox/changes") {
          const type = name === "Email/changes" ? "Email" : "Mailbox";
          const result = changes(type, args);
          controls.afterChanges?.(type);
          return [result.type ? "error" : name, result, id];
        }
        if (name === "Email/query") {
          const result = emailQuery(args);
          controls.afterEmailQuery?.();
          return [result.type ? "error" : name, result, id];
        }
        if (args["#ids"]) {
          const ref = z
            .object({ resultOf: z.string(), name: z.string(), path: z.enum(["/created", "/updated", "/ids"]) })
            .parse(args["#ids"]);
          const result = methodResponses.find(([method, , callId]) => method === ref.name && callId === ref.resultOf);
          if (!result) return ["error", { type: "invalidResultReference" }, id];
          args = { ...args, ids: result[1][ref.path.slice(1)] };
        }
        if (name === "Email/get") {
          const ids = z.array(z.string()).parse(args.ids);
          const properties = z.array(z.string()).parse(args.properties);
          const bodyProperties = z.array(z.string()).optional().parse(args.bodyProperties) ?? [];
          const list = emails
            .filter((email) => ids.includes(email.id))
            .map((email) =>
              Object.fromEntries(
                Object.entries(email)
                  .filter(([key]) => key === "id" || properties.includes(key))
                  .map(([key, value]) => [
                    key,
                    key === "bodyStructure" ? selectBodyProperties(email.bodyStructure, bodyProperties) : value,
                  ]),
              ),
            );
          return [
            name,
            {
              accountId: "d333333",
              state: controls.getState ?? (journal.Email.length ? state("Email") : "emails-state"),
              list,
              notFound: ids.filter((id) => !emails.some((email) => email.id === id)),
            },
            id,
          ];
        }
        if (name === "Mailbox/query") {
          const position = z.number().parse(args.position);
          const limit = z.number().parse(args.limit);
          return [
            name,
            {
              accountId: "d333333",
              queryState: "mailboxes-state",
              position,
              total: mailboxes.length,
              ids: mailboxes.slice(position, position + limit).map((mailbox) => mailbox.id),
            },
            id,
          ];
        }
        const ids = z.array(z.string()).parse(args.ids);
        return [
          name,
          {
            accountId: "d333333",
            state: controls.getState ?? (journal.Mailbox.length ? state("Mailbox") : "mailboxes-state"),
            list: mailboxes.filter((mailbox) => ids.includes(mailbox.id)),
            notFound: ids.filter((id) => !mailboxes.some((mailbox) => mailbox.id === id)),
          },
          id,
        ];
      };
      for (const call of body.methodCalls) {
        const response = invoke(call);
        methodResponses.push(controls.transform ? controls.transform(response) : response);
      }
      return Response.json({ methodResponses, sessionState: session.state });
    },
  });
  const dependencies: JmapTransportDependencies = {
    resolveEndpoint: async (endpoint) => ({ ...endpoint, addresses: [{ address: "127.0.0.1", family: 4 }] }),
    request: (options, callback) =>
      request({ ...options, protocol: "http:", hostname: "127.0.0.1", port: server.port, agent: false }, callback),
  };
  return {
    blobs,
    download,
    journal,
    state,
    origin,
    session,
    requests,
    mailboxes,
    emails,
    methodErrors,
    controls,
    dependencies,
    close: () => server.stop(true),
  };
}
