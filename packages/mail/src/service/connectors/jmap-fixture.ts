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
  const methodErrors = new Map<string, string>(); // Call ID -> method error, independent of sibling calls.
  const controls: {
    redirect: string | null;
    status: number | null;
    apiStatus: number | null;
    methodError: string | null;
    oversized: boolean;
    abort: boolean;
    handle?: (request: Request) => Response | undefined | Promise<Response | undefined>;
  } = { redirect: null, status: null, apiStatus: null, methodError: null, oversized: false, abort: false };
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
      const methodResponses: JmapInvocation[] = body.methodCalls.map(([name, args, id]) => {
        const methodError = methodErrors.get(id) ?? controls.methodError;
        if (methodError) return ["error", { type: methodError }, id];
        if (name === "Email/get") {
          const ids = z.array(z.string()).parse(args.ids);
          const properties = z.array(z.string()).parse(args.properties);
          const bodyProperties = z.array(z.string()).parse(args.bodyProperties);
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
            { accountId: "d333333", state: "emails-state", list, notFound: ids.filter((id) => !emails.some((email) => email.id === id)) },
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
          { accountId: "d333333", state: "mailboxes-state", list: mailboxes.filter((mailbox) => ids.includes(mailbox.id)), notFound: [] },
          id,
        ];
      });
      return Response.json({ methodResponses, sessionState: session.state });
    },
  });
  const dependencies: JmapTransportDependencies = {
    resolveEndpoint: async (endpoint) => ({ ...endpoint, addresses: [{ address: "127.0.0.1", family: 4 }] }),
    request: (options, callback) =>
      request({ ...options, protocol: "http:", hostname: "127.0.0.1", port: server.port, agent: false }, callback),
  };
  return { origin, session, requests, mailboxes, emails, methodErrors, controls, dependencies, close: () => server.stop(true) };
}
