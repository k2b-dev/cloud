import { request } from "node:http";
import { z } from "zod";
import type { JmapMailboxRights } from "./jmap";
import { JMAP_CORE, JMAP_MAIL, JMAP_SUBMISSION, type JmapInvocation } from "./jmap-client";
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
        if (controls.methodError) return ["error", { type: controls.methodError }, id];
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
  return { origin, session, requests, mailboxes, controls, dependencies, close: () => server.stop(true) };
}
