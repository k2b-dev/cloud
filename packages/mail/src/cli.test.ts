import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";

const servers: ReturnType<typeof Bun.serve>[] = [];
const temporaryFiles: string[] = [];

const MAILBOX_ID = "Mail01";
const COMMAND_ID = "00000000-0000-4000-8000-000000000002";
const IDENTITY_ID = "Ident1";
const DRAFT_ID = "Draft1";
const MESSAGE_ID = "Messg1";
const ATTACHMENT_ID = "Attch1";
const CONVERSATION_ID = "Convo1";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000008";
const FOLDER_ID = "Foldr1";
const USER_ID = "00000000-0000-4000-8000-000000000011";
const COMMENT_ID = "Commt1";
const WORKFLOW_ID = "00000000-0000-4000-8000-000000000013";
const WORKFLOW_VERSION_ID = "00000000-0000-4000-8000-000000000014";
const SOURCE_CONVERSATION_ID = "Convo2";
const REMINDER_ID = "Remnd1";
const SAVED_VIEW_ID = "View01";
const UPLOAD_ID = "00000000-0000-4000-8000-000000000019";
const BINDING_ID = "00000000-0000-4000-8000-000000000020";
const TAG_ID = "Tag001";
const COMPOSE_TEMPLATE_ID = "Templ1";
const SCHEDULED_SEND_ID = "Deliv1";
const AUTOMATIC_REPLY_ID = "Reply1";
const ATTACHMENT_LINK_ID = "00000000-0000-4000-8000-000000000026";
const REMOTE_CONTENT_RULE_ID = "00000000-0000-4000-8000-000000000027";
const INCOMING_AUTOMATION_ID = "Autom1";
const SECURITY_REPORT_ID = "00000000-0000-4000-8000-000000000029";
const SECURITY_POLICY_ID = "00000000-0000-4000-8000-000000000030";

const mailbox = {
  id: MAILBOX_ID,
  name: "Support",
  description: null,
  health: "active",
  healthReason: null,
  syncEnabled: true,
  searchBackend: "auto",
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
};

const platformMailboxSummary = {
  mailboxId: MAILBOX_ID,
  mailboxName: "Support",
  health: "active",
  syncEnabled: true,
  sync: { lastAt: null, lagSeconds: 12 },
  coverage: {
    hydration: { total: 2, covered: 2 },
    search: { total: 2, covered: 1 },
    threads: { total: 2, covered: 2 },
  },
  access: { total: 1, administrators: 1 },
  storage: null,
  attentionCount: 0,
};

const mailCommand = (state: string) => ({
  id: COMMAND_ID,
  mailboxId: MAILBOX_ID,
  kind: "send",
  state,
  actor: { kind: "user", userId: "00000000-0000-4000-8000-000000000099" },
  idempotencyKey: "mail-cli-test",
  correlationId: null,
  target: { draftId: DRAFT_ID },
  payload: {},
  selectedBindingId: null,
  rightsSnapshot: null,
  transportMetadata: {},
  result: {},
  attempt: state === "queued" ? 0 : 1,
  lastError: state === "failed" ? "SMTP rejected the message" : null,
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:01.000Z",
});

const api = (data: unknown, init?: ResponseInit) => Response.json(data, init);

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(temporaryFiles.splice(0).map((path) => rm(path, { force: true })));
});

const runCli = async (server: string, args: string[], input?: string) => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "../cloud-cli/src/index.ts", "--server", server, "--token", "test-token", ...args],
    cwd: new URL("..", import.meta.url).pathname,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
};

const withMailbox = (handler: (request: Request) => Response | Promise<Response>) =>
  Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/mail/mailboxes") return api([{ ...mailbox, permission: "admin" }]);
      if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}`) return api(mailbox);
      return handler(request);
    },
  });

test("focus lists a cross-mailbox queue without resolving one mailbox", async () => {
  const requests: string[] = [];
  const page = {
    items: [
      {
        id: CONVERSATION_ID,
        mailboxId: MAILBOX_ID,
        mailboxName: "Support",
        subject: "Release update",
        participantSummary: "Ada",
        latestMessageAt: "2026-08-19T10:00:00.000Z",
        workStatus: "needs_action",
        assigneeUserId: USER_ID,
        unread: true,
        flagged: false,
        hasAttachments: false,
        preview: "Ready to ship",
      },
    ],
    counts: { mine: 1, unassigned: 0, waiting: 0, all: 1 },
    mailboxCounts: [{ mailboxId: MAILBOX_ID, unread: 1, needsAction: 1 }],
    nextCursor: null,
  };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      if (request.method === "GET" && url.pathname === "/api/mail/overview/conversations") return api(page);
      return api({ message: "unexpected" }, { status: 500 });
    },
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "focus", "--view", "mine", "--limit", "25"]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(page);
  expect(requests).toEqual(["GET /api/mail/overview/conversations?view=mine&limit=25"]);
});

test("message report-phishing submits an explicit confirmed report", async () => {
  const received: Array<{ method: string; path: string; body: unknown }> = [];
  const report = {
    id: SECURITY_REPORT_ID,
    mailboxId: MAILBOX_ID,
    messageId: MESSAGE_ID,
    status: "new",
    reportCount: 1,
    assessment: { risk: "none", verdict: "clear", findings: [], linksDisabled: false, evaluatedAt: "2026-08-03T10:00:00.000Z" },
    resolutionNote: null,
    createdAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z",
  };
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}/security-report`) {
      received.push({ method: request.method, path: url.pathname, body: await request.json() });
      return api(report);
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "message",
    "report-phishing",
    MESSAGE_ID,
    "--mailbox",
    MAILBOX_ID,
    "--yes",
  ]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(report);
  expect(received).toEqual([
    {
      method: "POST",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}/security-report`,
      body: {},
    },
  ]);
});

test("admin security commands expose report and policy management", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const policy = {
    id: SECURITY_POLICY_ID,
    disposition: "deny",
    target: "sender_domain",
    value: "lookalike.example",
    note: "Confirmed phishing",
    enabled: true,
    createdAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z",
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/mail/admin/security/policies") {
        requests.push({ method: request.method, path: url.pathname, body: await request.json() });
        return api(policy);
      }
      if (request.method === "PATCH" && url.pathname === `/api/mail/admin/security/reports/${SECURITY_REPORT_ID}`) {
        requests.push({ method: request.method, path: url.pathname, body: await request.json() });
        return api({
          id: SECURITY_REPORT_ID,
          mailboxId: MAILBOX_ID,
          messageId: MESSAGE_ID,
          status: "confirmed",
          reportCount: 1,
          assessment: {
            risk: "warning",
            verdict: "suspicious",
            findings: [],
            linksDisabled: false,
            evaluatedAt: "2026-08-03T10:00:00.000Z",
          },
          resolutionNote: "Reviewed",
          createdAt: "2026-08-03T10:00:00.000Z",
          updatedAt: "2026-08-03T10:01:00.000Z",
        });
      }
      return api({ message: "unexpected" }, { status: 500 });
    },
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  const add = await runCli(origin, [
    "--json",
    "mail",
    "admin",
    "security",
    "rule",
    "add",
    "lookalike.example",
    "--disposition",
    "deny",
    "--target",
    "sender_domain",
    "--note",
    "Confirmed phishing",
  ]);
  const resolve = await runCli(origin, [
    "--json",
    "mail",
    "admin",
    "security",
    "report",
    "resolve",
    SECURITY_REPORT_ID,
    "--status",
    "confirmed",
    "--note",
    "Reviewed",
  ]);

  expect([add.exitCode, resolve.exitCode]).toEqual([0, 0]);
  expect(JSON.parse(add.stdout)).toEqual(policy);
  expect(JSON.parse(resolve.stdout)).toMatchObject({ id: SECURITY_REPORT_ID, status: "confirmed" });
  expect(requests).toEqual([
    {
      method: "POST",
      path: "/api/mail/admin/security/policies",
      body: {
        disposition: "deny",
        target: "sender_domain",
        value: "lookalike.example",
        note: "Confirmed phishing",
        enabled: true,
      },
    },
    {
      method: "PATCH",
      path: `/api/mail/admin/security/reports/${SECURITY_REPORT_ID}`,
      body: { status: "confirmed", resolutionNote: "Reviewed" },
    },
  ]);
}, 20_000);

test("conversation context commands expose Contacts and deterministic related mail", async () => {
  const requestedPaths: string[] = [];
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    requestedPaths.push(`${url.pathname}${url.search}`);
    const base = `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}`;
    if (request.method === "GET" && url.pathname === `${base}/context`) {
      return api({
        conversationId: CONVERSATION_ID,
        participants: [{ email: "sender@example.com", displayName: "Sender" }],
        contacts: { status: "ready", items: [], matchedEmails: [], nextCursor: null },
      });
    }
    if (request.method === "GET" && url.pathname === `${base}/contacts/system/${USER_ID}/history`) {
      return api({ items: [], nextCursor: null });
    }
    if (request.method === "GET" && url.pathname === `${base}/related`) {
      return api([
        {
          id: "rel123",
          subject: "Re: Release update",
          participantSummary: "Ada",
          latestMessageAt: "2026-08-18T12:00:00.000Z",
          preview: "Earlier context",
          reasons: [{ kind: "participant", value: "ada@example.test" }],
        },
      ]);
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  const commands = [
    ["--json", "mail", "conversation", "context", CONVERSATION_ID, "--mailbox", MAILBOX_ID],
    ["--json", "mail", "conversation", "related", CONVERSATION_ID, "--mailbox", MAILBOX_ID, "--limit", "3"],
    ["--json", "mail", "conversation", "contact-history", CONVERSATION_ID, "system", USER_ID, "--mailbox", MAILBOX_ID],
    ["mail", "conversation", "related", CONVERSATION_ID, "--mailbox", MAILBOX_ID, "--limit", "3"],
  ];
  const results = [];
  for (const command of commands) results.push(await runCli(origin, command));

  expect(results.every((result) => result.exitCode === 0 && result.stderr === "")).toBe(true);
  expect(JSON.parse(results[1]!.stdout)).toEqual([
    {
      id: "rel123",
      subject: "Re: Release update",
      participantSummary: "Ada",
      latestMessageAt: "2026-08-18T12:00:00.000Z",
      preview: "Earlier context",
      reasons: [{ kind: "participant", value: "ada@example.test" }],
    },
  ]);
  expect(results[3]!.stdout).toContain("WHY RELATED");
  expect(results[3]!.stdout).toContain("participant ada@example.test");
  expect(requestedPaths).toContain(`/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/related?limit=3`);
}, 20_000);

test("conversation drafts lists resumable work for one conversation", async () => {
  const drafts = [
    {
      id: DRAFT_ID,
      intent: "reply",
      subject: "Re: Support request",
      bodyPreview: "We are looking into this.",
      createdByDisplayName: "Writer",
      updatedAt: "2026-07-23T09:00:00.000Z",
    },
  ];
  let requestedPath = "";
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    requestedPath = `${url.pathname}${url.search}`;
    if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/drafts`) {
      return api(drafts);
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "conversation",
    "drafts",
    CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
    "--limit",
    "12",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(requestedPath).toBe(`/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/drafts?limit=12`);
  expect(JSON.parse(result.stdout)).toEqual(drafts);
});

test("mailbox configure maps automatic reply access to the mailbox policy", async () => {
  let requestBody: unknown;
  const server = withMailbox(async (request) => {
    if (request.method === "PATCH" && new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}`) {
      requestBody = await request.json();
      return api({ ...mailbox, automaticReplyManagementPermission: "write" });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "configure",
    "--mailbox",
    MAILBOX_ID,
    "--automatic-replies",
    "writers",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(requestBody).toEqual({ automaticReplyManagementPermission: "write" });
});

test("subscription commands expose safe list actions and durable disposition", async () => {
  const listKey = "news.example.org";
  const subscription = {
    listKey,
    name: "Example News",
    address: listKey,
    status: "active",
    unsubscribe: {
      kind: "one_click",
      href: "https://news.example.org/unsubscribe/opaque",
    },
    postHref: "mailto:news@example.org",
    helpHref: "https://news.example.org/help",
    archiveHref: "https://news.example.org/archive",
    messageCount: 12,
    recentMessageCount: 3,
    conversationCount: 4,
    lastMessageAt: "2026-07-24T08:00:00.000Z",
    lastSubject: "July update",
    lastSender: "Example News",
    lastMessageId: MESSAGE_ID,
    lastConversationId: CONVERSATION_ID,
    unsubscribeRequestedAt: null,
    unsubscribeErrorCode: null,
  };
  const writes: Array<{ path: string; body: unknown }> = [];
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    const base = `/api/mail/mailboxes/${MAILBOX_ID}/subscriptions`;
    if (request.method === "GET" && url.pathname === base) {
      return api({ items: [subscription], nextCursor: null });
    }
    if (request.method === "POST" && url.pathname === `${base}/unsubscribe`) {
      writes.push({ path: url.pathname, body: await request.json() });
      return api({
        listKey,
        status: "unsubscribe_requested",
        requestedAt: "2026-07-24T08:30:00.000Z",
      });
    }
    if (request.method === "POST" && url.pathname === `${base}/disposition`) {
      writes.push({ path: url.pathname, body: await request.json() });
      return api({ commandCount: 12, truncated: false });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  const listed = await runCli(origin, ["--json", "mail", "subscription", "list", "--mailbox", MAILBOX_ID]);
  const inspected = await runCli(origin, ["--json", "mail", "subscription", "get", listKey, "--mailbox", MAILBOX_ID]);
  const unsubscribed = await runCli(origin, ["--json", "mail", "subscription", "unsubscribe", listKey, "--mailbox", MAILBOX_ID, "--yes"]);
  const disposed = await runCli(origin, [
    "--json",
    "mail",
    "subscription",
    "dispose",
    listKey,
    "--mailbox",
    MAILBOX_ID,
    "--destination",
    "archive",
    "--yes",
  ]);

  expect([listed.exitCode, inspected.exitCode, unsubscribed.exitCode, disposed.exitCode]).toEqual([0, 0, 0, 0]);
  expect(JSON.parse(listed.stdout).items).toEqual([subscription]);
  expect(JSON.parse(inspected.stdout)).toEqual(subscription);
  expect(JSON.parse(unsubscribed.stdout)).toMatchObject({ listKey, status: "unsubscribe_requested" });
  expect(JSON.parse(disposed.stdout)).toEqual({ commandCount: 12, truncated: false });
  expect(writes[0]).toEqual({
    path: `/api/mail/mailboxes/${MAILBOX_ID}/subscriptions/unsubscribe`,
    body: { listKey, href: subscription.unsubscribe.href },
  });
  expect(writes[1]?.path).toBe(`/api/mail/mailboxes/${MAILBOX_ID}/subscriptions/disposition`);
  expect(writes[1]?.body).toMatchObject({
    listKey,
    disposition: "archive",
  });
  expect((writes[1]?.body as { idempotencyKey?: string }).idempotencyKey).toBeString();
});

test("remote content commands manage personal sender and domain rules", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const mailRule = {
    id: REMOTE_CONTENT_RULE_ID,
    mailboxId: MAILBOX_ID,
    scope: "sender",
    value: "sender@example.com",
    createdAt: "2026-07-25T08:00:00.000Z",
  };
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    const base = `/api/mail/mailboxes/${MAILBOX_ID}/remote-content-rules`;
    if (request.method === "GET" && url.pathname === base) return api([mailRule]);
    if (request.method === "POST" && url.pathname === base) {
      const body = await request.json();
      requests.push({ method: request.method, path: url.pathname, body });
      return api({ ...mailRule, scope: body.scope, value: body.value });
    }
    if (request.method === "DELETE" && url.pathname === `${base}/${REMOTE_CONTENT_RULE_ID}`) {
      requests.push({ method: request.method, path: url.pathname, body: null });
      return api({ id: REMOTE_CONTENT_RULE_ID });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  const listed = await runCli(origin, ["--json", "mail", "remote-content", "list", "--mailbox", MAILBOX_ID]);
  const sender = await runCli(origin, ["--json", "mail", "remote-content", "allow-sender", "sender@example.com", "--mailbox", MAILBOX_ID]);
  const domain = await runCli(origin, ["--json", "mail", "remote-content", "allow-domain", "example.com", "--mailbox", MAILBOX_ID]);
  const refused = await runCli(origin, ["mail", "remote-content", "remove", REMOTE_CONTENT_RULE_ID, "--mailbox", MAILBOX_ID]);
  const removed = await runCli(origin, [
    "--json",
    "mail",
    "remote-content",
    "remove",
    REMOTE_CONTENT_RULE_ID,
    "--mailbox",
    MAILBOX_ID,
    "--yes",
  ]);

  expect([listed, sender, domain, removed].every((result) => result.exitCode === 0 && result.stderr === "")).toBe(true);
  expect(JSON.parse(listed.stdout)).toEqual([mailRule]);
  expect(JSON.parse(sender.stdout).value).toBe("sender@example.com");
  expect(JSON.parse(domain.stdout).value).toBe("example.com");
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr).toContain("Pass --yes");
  expect(requests).toEqual([
    {
      method: "POST",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/remote-content-rules`,
      body: { scope: "sender", value: "sender@example.com" },
    },
    { method: "POST", path: `/api/mail/mailboxes/${MAILBOX_ID}/remote-content-rules`, body: { scope: "domain", value: "example.com" } },
    { method: "DELETE", path: `/api/mail/mailboxes/${MAILBOX_ID}/remote-content-rules/${REMOTE_CONTENT_RULE_ID}`, body: null },
  ]);
});

test("search forwards nested expressions and cursors", async () => {
  let requestBody: unknown;
  const server = withMailbox(async (request) => {
    if (new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/search`) {
      requestBody = await request.json();
      return api({ items: [], nextCursor: null, backend: "native" });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(
    `http://127.0.0.1:${server.port}`,
    ["--json", "mail", "search", "--mailbox", MAILBOX_ID, "--expression-stdin", "--cursor", "next-page", "--sort", "newest"],
    JSON.stringify({
      type: "and",
      expressions: [
        { type: "text", field: "subject", query: "invoice", match: "contains" },
        { type: "not", expression: { type: "text", field: "from", query: "bot" } },
      ],
    }),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(requestBody).toEqual({
    expression: {
      type: "and",
      expressions: [
        { type: "text", field: "subject", query: "invoice", match: "contains" },
        { type: "not", expression: { type: "text", field: "from", query: "bot", match: "words" } },
      ],
    },
    sort: "newest",
    cursor: "next-page",
    limit: 50,
  });
});

test("search preserves commas inside repeated free-text terms", async () => {
  let requestBody: unknown;
  const server = withMailbox(async (request) => {
    if (new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/search`) {
      requestBody = await request.json();
      return api({ items: [], nextCursor: null, backend: "native" });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "search",
    "--mailbox",
    MAILBOX_ID,
    "--subject",
    "Kolb, Valentin",
    "--subject",
    "Invoice, July",
  ]);

  expect(result.exitCode).toBe(0);
  expect(requestBody).toMatchObject({
    expression: {
      type: "and",
      expressions: [
        { type: "text", field: "subject", query: "Kolb, Valentin" },
        { type: "text", field: "subject", query: "Invoice, July" },
      ],
    },
  });
});

test("mailbox short-id resolution uses the direct resource endpoint independently of the bounded list", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      requests.push(`${url.pathname}${url.search}`);
      if (request.method === "GET" && url.pathname === "/api/mail/mailboxes") {
        if (url.searchParams.get("name") === MAILBOX_ID) return api([]);
        return api({ message: "bounded mailbox list must not resolve an id" }, { status: 500 });
      }
      if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}`) return api(mailbox);
      return api({ message: "unexpected" }, { status: 500 });
    },
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["--jsonl", "mail", "mailbox", "get", MAILBOX_ID]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ id: MAILBOX_ID, permission: null });
  expect(requests).toEqual([
    `/api/mail/mailboxes/${MAILBOX_ID}`,
    `/api/mail/mailboxes?limit=2&name=${MAILBOX_ID}`,
    `/api/mail/mailboxes/${MAILBOX_ID}`,
  ]);
});

test("legacy mailbox UUIDs are rejected before any API request", async () => {
  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requestCount += 1;
      return api({ message: "unexpected" }, { status: 500 });
    },
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["mail", "mailbox", "get", "00000000-0000-4000-8000-000000000001"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("legacy UUIDs are not supported");
  expect(requestCount).toBe(0);
});

test("legacy UUIDs are rejected for public Mail resources", async () => {
  let messageRequestCount = 0;
  const server = withMailbox((request) => {
    if (new URL(request.url).pathname.includes("/messages/")) messageRequestCount += 1;
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "mail",
    "message",
    "get",
    "00000000-0000-4000-8000-000000000005",
    "--mailbox",
    MAILBOX_ID,
  ]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Message id must be an exact six-character Mail resource id");
  expect(messageRequestCount).toBe(0);
});

test("mailbox name resolution uses an exact server-side lookup", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      requests.push(`${url.pathname}${url.search}`);
      if (request.method === "GET" && url.pathname === "/api/mail/mailboxes") {
        if (url.searchParams.get("name") === mailbox.name) return api([{ ...mailbox, permission: "admin" }]);
        return api({ message: "mailbox name lookup must be exact" }, { status: 500 });
      }
      if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}`) return api(mailbox);
      return api({ message: "unexpected" }, { status: 500 });
    },
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["--jsonl", "mail", "mailbox", "get", mailbox.name]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(requests[0]).toBe("/api/mail/mailboxes?limit=2&name=Support");
  expect(JSON.parse(result.stdout)).toMatchObject({ id: MAILBOX_ID, permission: "admin" });
});

test("six-character mailbox names remain exact selectors", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (request.method !== "GET" || url.pathname !== "/api/mail/mailboxes") {
        if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}`) {
          return api({ ...mailbox, name: "Shared" });
        }
        if (request.method === "GET" && url.pathname === "/api/mail/mailboxes/Shared") {
          return api({ message: "not found" }, { status: 404 });
        }
        return api({ message: "unexpected" }, { status: 500 });
      }
      if (url.searchParams.get("name") === "Shared") return api([{ ...mailbox, name: "Shared", permission: "write" }]);
      return api([]);
    },
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "mailbox", "get", "Shared"]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ id: MAILBOX_ID, name: "Shared", permission: "write" });
});

test("mailbox resolution rejects a direct-id and exact-name collision outside a full bounded list", async () => {
  const nameCollision = { ...mailbox, id: "Mail02", name: MAILBOX_ID, permission: "admin" };
  const boundedMailboxes = Array.from({ length: 200 }, (_, index) => ({
    ...mailbox,
    id: `M${String(index).padStart(5, "0")}`,
    name: `Mailbox ${index}`,
    permission: "admin" as const,
  }));
  let directRequestCount = 0;
  let boundedListRequestCount = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/mail/mailboxes") {
        if (url.searchParams.get("name") === MAILBOX_ID) return api([nameCollision]);
        boundedListRequestCount += 1;
        return api(boundedMailboxes);
      }
      if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}`) {
        directRequestCount += 1;
        return api(mailbox);
      }
      return api({ message: "unexpected" }, { status: 500 });
    },
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["mail", "mailbox", "get", MAILBOX_ID]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`Mailbox "${MAILBOX_ID}" is ambiguous`);
  expect(directRequestCount).toBe(1);
  expect(boundedListRequestCount).toBe(0);
});

test("compose template and style commands preserve exact source input", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const template = {
    id: COMPOSE_TEMPLATE_ID,
    mailboxId: MAILBOX_ID,
    kind: "signature",
    scope: "mailbox",
    ownerUserId: null,
    name: "Company",
    shortcut: "company",
    body: "Regards,\n{{ actor.display_name }}",
    revision: 1,
    archivedAt: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
  const signatureDefault = {
    mailboxId: MAILBOX_ID,
    senderIdentityId: IDENTITY_ID,
    userId: null,
    templateId: COMPOSE_TEMPLATE_ID,
    revision: 1,
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    const body = request.method === "GET" ? null : await request.json();
    requests.push({ method: request.method, path: url.pathname, body });
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/compose-templates` && request.method === "POST") return api(template);
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/compose-signature-defaults` && request.method === "GET") {
      return api([signatureDefault]);
    }
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/compose-style` && request.method === "GET") {
      return api({ mailboxId: MAILBOX_ID, customCss: "", revision: 1, updatedAt: "2026-07-17T00:00:00.000Z" });
    }
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/compose-style` && request.method === "PUT") {
      return api({
        mailboxId: MAILBOX_ID,
        customCss: ".mail-content { color: #123456; }",
        revision: 2,
        updatedAt: "2026-07-17T00:00:01.000Z",
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const created = await runCli(
    `http://127.0.0.1:${server.port}`,
    [
      "--json",
      "mail",
      "compose",
      "template",
      "create",
      "--mailbox",
      MAILBOX_ID,
      "--kind",
      "signature",
      "--scope",
      "mailbox",
      "--name",
      "Company",
      "--shortcut",
      "company",
      "--body-stdin",
    ],
    "Regards,\n{{ actor.display_name }}",
  );
  const styled = await runCli(
    `http://127.0.0.1:${server.port}`,
    ["--json", "mail", "compose", "style", "set", "--mailbox", MAILBOX_ID, "--css-stdin"],
    ".mail-content { color: #123456; }",
  );
  const defaults = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "compose",
    "signature",
    "list",
    "--mailbox",
    MAILBOX_ID,
  ]);

  expect(created.exitCode).toBe(0);
  expect(styled.exitCode).toBe(0);
  expect(defaults.exitCode).toBe(0);
  expect(JSON.parse(defaults.stdout)).toEqual([signatureDefault]);
  expect(requests).toEqual([
    {
      method: "POST",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/compose-templates`,
      body: {
        kind: "signature",
        scope: "mailbox",
        name: "Company",
        shortcut: "company",
        body: "Regards,\n{{ actor.display_name }}",
      },
    },
    { method: "GET", path: `/api/mail/mailboxes/${MAILBOX_ID}/compose-style`, body: null },
    {
      method: "PUT",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/compose-style`,
      body: { expectedRevision: 1, customCss: ".mail-content { color: #123456; }" },
    },
    {
      method: "GET",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/compose-signature-defaults`,
      body: null,
    },
  ]);
});

test("compose rendering commands send one validated draft context", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const draft = {
    senderIdentityId: IDENTITY_ID,
    to: [{ name: null, address: "recipient@example.com" }],
    cc: [],
    bcc: [],
    subject: "Hello",
    body: "Draft body",
    format: "markdown",
  };
  const validatedDraft = {
    ...draft,
    priority: "normal",
    requestDeliveryReceipt: false,
    requestReadReceipt: false,
  };
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (request.method !== "POST") return api({ message: "unexpected" }, { status: 500 });
    requests.push({ path: url.pathname, body: await request.json() });
    if (url.pathname.endsWith("/compose-snippet")) return api({ markdown: "Rendered snippet" });
    if (url.pathname.endsWith("/compose-suggestions")) {
      return api([
        {
          templateId: COMPOSE_TEMPLATE_ID,
          name: "Greeting",
          shortcut: "hello",
          kind: "snippet",
          markdown: "Rendered greeting",
        },
      ]);
    }
    if (url.pathname.endsWith("/compose-preview")) return api({ html: "<p>Draft body</p>", text: "Draft body" });
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  const input = JSON.stringify(draft);

  const snippet = await runCli(
    origin,
    [
      "--json",
      "mail",
      "compose",
      "snippet",
      "render",
      COMPOSE_TEMPLATE_ID,
      "--mailbox",
      MAILBOX_ID,
      "--conversation",
      CONVERSATION_ID,
      "--draft-stdin",
    ],
    input,
  );
  const suggestions = await runCli(
    origin,
    ["--json", "mail", "compose", "suggestions", "gre", "--mailbox", MAILBOX_ID, "--conversation", CONVERSATION_ID, "--draft-stdin"],
    input,
  );
  const preview = await runCli(
    origin,
    ["--json", "mail", "compose", "preview", "--mailbox", MAILBOX_ID, "--conversation", CONVERSATION_ID, "--draft-stdin"],
    input,
  );

  expect([snippet, suggestions, preview].every((result) => result.exitCode === 0 && result.stderr === "")).toBe(true);
  expect(requests).toEqual([
    {
      path: `/api/mail/mailboxes/${MAILBOX_ID}/compose-snippet`,
      body: { templateId: COMPOSE_TEMPLATE_ID, draft: validatedDraft, conversationId: CONVERSATION_ID },
    },
    {
      path: `/api/mail/mailboxes/${MAILBOX_ID}/compose-suggestions`,
      body: { query: "gre", draft: validatedDraft, conversationId: CONVERSATION_ID },
    },
    {
      path: `/api/mail/mailboxes/${MAILBOX_ID}/compose-preview`,
      body: { draft: validatedDraft, conversationId: CONVERSATION_ID },
    },
  ]);
  expect(JSON.parse(snippet.stdout)).toEqual({ markdown: "Rendered snippet" });
  expect(JSON.parse(suggestions.stdout)[0]).toMatchObject({ shortcut: "hello", markdown: "Rendered greeting" });
  expect(JSON.parse(preview.stdout)).toEqual({ html: "<p>Draft body</p>", text: "Draft body" });
});

test("local tag CLI creates catalog entries and fences conversation assignments", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const tag = {
    id: TAG_ID,
    mailboxId: MAILBOX_ID,
    name: "Priority",
    color: "#6b7280",
    revision: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    const body = request.method === "GET" ? null : await request.json();
    requests.push({ method: request.method, path: url.pathname, body });
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/local-tags` && request.method === "POST") return api(tag);
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/local-tags` && request.method === "PUT") {
      return api({ conversationId: CONVERSATION_ID, conversationRevision: 8, tags: [tag] });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const created = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "tag", "create", "Priority", "--mailbox", MAILBOX_ID]);
  const assigned = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "conversation",
    "tag",
    "set",
    CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
    "--revision",
    "7",
    "--tag",
    TAG_ID,
  ]);

  expect(created.exitCode).toBe(0);
  expect(assigned.exitCode).toBe(0);
  expect(requests).toEqual([
    {
      method: "POST",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/local-tags`,
      body: { name: "Priority", color: "#6b7280" },
    },
    {
      method: "PUT",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/local-tags`,
      body: { expectedRevision: 7, tagIds: [TAG_ID] },
    },
  ]);
});

test("conversation tag add exposes bounded additive bulk assignment", async () => {
  let requestBody: unknown;
  const server = withMailbox(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/conversations/local-tags`) {
      requestBody = await request.json();
      return api({
        updatedConversationIds: [CONVERSATION_ID],
        unchangedConversationIds: [SOURCE_CONVERSATION_ID],
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "conversation",
    "tag",
    "add",
    "--mailbox",
    MAILBOX_ID,
    "--conversation",
    CONVERSATION_ID,
    "--conversation",
    SOURCE_CONVERSATION_ID,
    "--conversation",
    CONVERSATION_ID,
    "--tag",
    TAG_ID,
    "--tag",
    COMPOSE_TEMPLATE_ID,
    "--tag",
    TAG_ID,
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(requestBody).toEqual({
    conversationIds: [CONVERSATION_ID, SOURCE_CONVERSATION_ID],
    tagIds: [TAG_ID, COMPOSE_TEMPLATE_ID],
  });
  expect(JSON.parse(result.stdout)).toEqual({
    updatedConversationIds: [CONVERSATION_ID],
    unchangedConversationIds: [SOURCE_CONVERSATION_ID],
  });
});

test("reference config set preserves unspecified settings", async () => {
  let requestBody: unknown;
  const current = {
    mailboxId: MAILBOX_ID,
    pattern: "SUP-{{ year }}-{{ sequence }}",
    nextSequence: "42",
    enabled: true,
    includeInReplySubjects: true,
    revision: 3,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:01.000Z",
  };
  const updated = { ...current, includeInReplySubjects: false, revision: 4 };
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/reference-number-configuration` && request.method === "GET") {
      return api(current);
    }
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/reference-number-configuration` && request.method === "PUT") {
      requestBody = await request.json();
      return api(updated);
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "reference",
    "config",
    "set",
    "--mailbox",
    MAILBOX_ID,
    "--exclude-from-reply-subjects",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(requestBody).toEqual({
    expectedRevision: 3,
    pattern: "SUP-{{ year }}-{{ sequence }}",
    enabled: true,
    includeInReplySubjects: false,
  });
  expect(JSON.parse(result.stdout)).toEqual(updated);
});

test("reference list and ensure expose the permanent value without a row id", async () => {
  const reference = {
    mailboxId: MAILBOX_ID,
    conversationId: CONVERSATION_ID,
    configurationRevision: 3,
    patternSnapshot: "SUP-{{ year }}-{{ sequence }}",
    value: "SUP-2026-42",
    sequence: "42",
    role: "primary",
    allocatedBy: { kind: "user", id: USER_ID },
    allocatedAt: "2026-07-12T00:00:00.000Z",
  };
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    const path = `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/references`;
    if (url.pathname !== path) return api({ message: "unexpected" }, { status: 500 });
    if (request.method === "GET") return api([reference]);
    if (request.method === "POST") return api({ reference, conversationRevision: 2, created: false });
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const listed = await runCli(`http://127.0.0.1:${server.port}`, ["mail", "reference", "list", CONVERSATION_ID, "--mailbox", MAILBOX_ID]);
  const ensured = await runCli(`http://127.0.0.1:${server.port}`, [
    "mail",
    "reference",
    "ensure",
    CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
  ]);

  expect(listed.exitCode).toBe(0);
  expect(listed.stdout).toContain("SUP-2026-42");
  expect(listed.stdout).not.toContain(USER_ID);
  expect(ensured.exitCode).toBe(0);
  expect(ensured.stdout).toContain("Found SUP-2026-42 (primary).");
});

test("deleted mailbox CLI lists, reads, and restores retained mailboxes", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  const deleted = { ...mailbox, deletedAt: "2026-07-16T12:00:00.000Z", permission: "admin" };
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    requests.push({ method: request.method, path: `${url.pathname}${url.search}` });
    if (request.method === "GET" && url.pathname === "/api/mail/mailboxes/deleted")
      return api({ items: [deleted], nextCursor: "next-page" });
    if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/deleted`) return api(deleted);
    if (request.method === "POST" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/restore`) {
      return api({ ...mailbox, health: "paused", healthReason: "Mailbox restored", syncEnabled: false });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const listed = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "mailbox", "deleted", "list"]);
  const read = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "mailbox", "deleted", "get", MAILBOX_ID]);
  const restored = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "mailbox", "restore", MAILBOX_ID, "--yes"]);

  expect(listed.exitCode).toBe(0);
  expect(JSON.parse(listed.stdout)).toEqual({ items: [deleted], nextCursor: "next-page" });
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.stdout)).toEqual(deleted);
  expect(restored.exitCode).toBe(0);
  expect(JSON.parse(restored.stdout)).toMatchObject({ id: MAILBOX_ID, health: "paused", syncEnabled: false });
  expect(requests).toContainEqual({ method: "GET", path: "/api/mail/mailboxes/deleted?limit=100" });
  expect(requests).toContainEqual({ method: "GET", path: `/api/mail/mailboxes/${MAILBOX_ID}/deleted` });
  expect(requests).toContainEqual({ method: "POST", path: `/api/mail/mailboxes/${MAILBOX_ID}/restore` });
});

test("conversation update sends one optimistic collaboration mutation", async () => {
  let requestBody: unknown;
  const server = withMailbox(async (request) => {
    if (
      request.method === "PATCH" &&
      new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/collaboration`
    ) {
      requestBody = await request.json();
      return api({
        conversationId: CONVERSATION_ID,
        assignee: { id: USER_ID, uid: "writer", displayName: "Writer", avatarHash: null },
        workStatus: "waiting",
        snoozedUntil: null,
        revision: 5,
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "conversation",
    "update",
    CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
    "--revision",
    "4",
    "--assignee",
    USER_ID,
    "--reopen",
  ]);

  expect(result.exitCode).toBe(0);
  expect(requestBody).toEqual({
    expectedRevision: 4,
    assigneeUserId: USER_ID,
    completion: "open",
  });
  expect(JSON.parse(result.stdout)).toMatchObject({ revision: 5, workStatus: "waiting" });
});

test("conversation merge requires confirmation and forwards both revisions", async () => {
  let requests = 0;
  let requestBody: unknown;
  const server = withMailbox(async (request) => {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/merge`
    ) {
      requests += 1;
      requestBody = await request.json();
      return api({
        target: { id: CONVERSATION_ID, revision: 5, messageCount: 3 },
        removedConversationId: SOURCE_CONVERSATION_ID,
        movedMessageCount: 1,
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const args = [
    "--json",
    "mail",
    "conversation",
    "merge",
    CONVERSATION_ID,
    SOURCE_CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
    "--target-revision",
    "4",
    "--source-revision",
    "2",
    "--reason",
    "same request",
  ];
  const denied = await runCli(`http://127.0.0.1:${server.port}`, args);
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain("Pass --yes");
  expect(requests).toBe(0);

  const confirmed = await runCli(`http://127.0.0.1:${server.port}`, [...args, "--yes"]);
  expect(confirmed.exitCode).toBe(0);
  expect(requestBody).toEqual({
    sourceConversationId: SOURCE_CONVERSATION_ID,
    expectedTargetRevision: 4,
    expectedSourceRevision: 2,
    reason: "same request",
    confirm: true,
  });
  expect(JSON.parse(confirmed.stdout)).toMatchObject({ movedMessageCount: 1 });
});

test("conversation split forwards the bounded selected message set", async () => {
  let requestBody: unknown;
  const server = withMailbox(async (request) => {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/split`
    ) {
      requestBody = await request.json();
      return api({
        source: { id: CONVERSATION_ID, revision: 6, messageCount: 2 },
        created: { id: SOURCE_CONVERSATION_ID, revision: 1, messageCount: 1 },
        movedMessageCount: 1,
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "conversation",
    "split",
    CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
    "--revision",
    "5",
    "--message",
    MESSAGE_ID,
    "--yes",
  ]);
  expect(result.exitCode).toBe(0);
  expect(requestBody).toEqual({ messageIds: [MESSAGE_ID], expectedRevision: 5, confirm: true });
  expect(JSON.parse(result.stdout)).toMatchObject({ movedMessageCount: 1 });
});

test("conversation reassign-message requires confirmation and forwards revision fencing", async () => {
  let requests = 0;
  let requestBody: unknown;
  const server = withMailbox(async (request) => {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/messages/${MESSAGE_ID}/reassign`
    ) {
      requests += 1;
      requestBody = await request.json();
      return api({
        source: { id: CONVERSATION_ID, revision: 6, messageCount: 1 },
        target: { id: SOURCE_CONVERSATION_ID, revision: 3, messageCount: 2 },
        messageId: MESSAGE_ID,
        movedCommentCount: 0,
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const args = [
    "--json",
    "mail",
    "conversation",
    "reassign-message",
    CONVERSATION_ID,
    MESSAGE_ID,
    SOURCE_CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
    "--source-revision",
    "5",
    "--target-revision",
    "2",
    "--reason",
    "correct provider thread",
  ];
  const denied = await runCli(`http://127.0.0.1:${server.port}`, args);
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain("Pass --yes");
  expect(requests).toBe(0);

  const confirmed = await runCli(`http://127.0.0.1:${server.port}`, [...args, "--yes"]);
  expect(confirmed.exitCode).toBe(0);
  expect(requestBody).toEqual({
    targetConversationId: SOURCE_CONVERSATION_ID,
    expectedSourceRevision: 5,
    expectedTargetRevision: 2,
    reason: "correct provider thread",
    confirm: true,
  });
  expect(JSON.parse(confirmed.stdout)).toMatchObject({ messageId: MESSAGE_ID, movedCommentCount: 0 });
});

test("reminder commands use revisioned create, reschedule, read, and cancel requests", async () => {
  const requests: Array<{ method: string; body: unknown }> = [];
  const reminder = {
    id: REMINDER_ID,
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    dueAt: "2026-08-01T12:00:00.000Z",
    state: "pending",
    revision: 1,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
  const server = withMailbox(async (request) => {
    if (new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/reminder`) {
      const body = request.method === "GET" ? null : await request.json();
      requests.push({ method: request.method, body });
      if (request.method === "DELETE") return api({ ...reminder, state: "canceled", revision: 3 });
      if (request.method === "PUT" && body && (body as { expectedRevision?: number }).expectedRevision === 1) {
        return api({ ...reminder, dueAt: "2026-08-02T12:00:00.000Z", revision: 2 });
      }
      return api(reminder);
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const created = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "reminder",
    "set",
    CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
    "--due",
    "2026-08-01T12:00:00Z",
  ]);
  const loaded = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "reminder",
    "get",
    CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
  ]);
  const rescheduled = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "reminder",
    "set",
    CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
    "--due",
    "2026-08-02T14:00:00+02:00",
    "--revision",
    "1",
  ]);
  const canceled = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "reminder",
    "cancel",
    CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
    "--revision",
    "2",
  ]);

  expect(created.exitCode).toBe(0);
  expect(loaded.exitCode).toBe(0);
  expect(rescheduled.exitCode).toBe(0);
  expect(canceled.exitCode).toBe(0);
  expect(requests).toEqual([
    { method: "PUT", body: { dueAt: "2026-08-01T12:00:00.000Z", expectedRevision: null } },
    { method: "GET", body: null },
    { method: "PUT", body: { dueAt: "2026-08-02T12:00:00.000Z", expectedRevision: 1 } },
    { method: "DELETE", body: { expectedRevision: 2 } },
  ]);
  expect(JSON.parse(canceled.stdout)).toMatchObject({ state: "canceled", revision: 3 });
}, 30_000);

test("reminder set rejects dates without an explicit UTC offset", async () => {
  for (const due of ["2026-08-01", "0", "2026-02-30T12:00:00Z"]) {
    const result = await runCli("http://127.0.0.1:1", ["mail", "reminder", "set", CONVERSATION_ID, "--mailbox", MAILBOX_ID, "--due", due]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--due must be an ISO date-time with a UTC offset");
  }
}, 10_000);

test("saved view commands cover structured filters and revisioned lifecycle", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const savedView = {
    id: SAVED_VIEW_ID,
    mailboxId: MAILBOX_ID,
    scope: "private",
    ownerUserId: USER_ID,
    name: "My queue",
    filter: {
      expression: {
        type: "and",
        expressions: [{ type: "work_status", value: "needs_action" }, { type: "assigned_to_me" }],
      },
      sort: "newest",
    },
    revision: 1,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const requestPath = `${url.pathname}${url.search}`;
    if (path === `/api/mail/mailboxes/${MAILBOX_ID}/saved-views` && request.method === "GET") {
      requests.push({ method: request.method, path: requestPath, body: null });
      return api([savedView]);
    }
    if (path === `/api/mail/mailboxes/${MAILBOX_ID}/saved-views` && request.method === "POST") {
      requests.push({ method: request.method, path: requestPath, body: await request.json() });
      return api(savedView);
    }
    if (path === `/api/mail/mailboxes/${MAILBOX_ID}/saved-views/${SAVED_VIEW_ID}` && request.method === "GET") {
      requests.push({ method: request.method, path: requestPath, body: null });
      return api(savedView);
    }
    if (path === `/api/mail/mailboxes/${MAILBOX_ID}/saved-views/${SAVED_VIEW_ID}` && request.method === "PATCH") {
      const body = await request.json();
      requests.push({ method: request.method, path: requestPath, body });
      return api({ ...savedView, filter: (body as { filter: unknown }).filter, revision: 2 });
    }
    if (path === `/api/mail/mailboxes/${MAILBOX_ID}/saved-views/${SAVED_VIEW_ID}/conversations` && request.method === "GET") {
      requests.push({ method: request.method, path: requestPath, body: null });
      return api({ items: [], nextCursor: null });
    }
    if (path === `/api/mail/mailboxes/${MAILBOX_ID}/saved-views/${SAVED_VIEW_ID}` && request.method === "DELETE") {
      requests.push({ method: request.method, path: requestPath, body: await request.json() });
      return api({ id: SAVED_VIEW_ID });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const created = await runCli(
    `http://127.0.0.1:${server.port}`,
    ["--json", "mail", "saved-view", "create", "My queue", "--mailbox", MAILBOX_ID, "--filter-stdin"],
    JSON.stringify(savedView.filter),
  );
  const listed = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "saved-view", "list", "--mailbox", MAILBOX_ID]);
  const loaded = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "saved-view",
    "get",
    SAVED_VIEW_ID,
    "--mailbox",
    MAILBOX_ID,
  ]);
  const updatedFilter = {
    expression: {
      type: "and",
      expressions: [
        { type: "work_status", value: "waiting" },
        { type: "snoozed", value: false },
      ],
    },
    sort: "relevance",
  };
  const updated = await runCli(
    `http://127.0.0.1:${server.port}`,
    ["--json", "mail", "saved-view", "update", SAVED_VIEW_ID, "--mailbox", MAILBOX_ID, "--revision", "1", "--filter-stdin"],
    JSON.stringify(updatedFilter),
  );
  const conversations = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "saved-view",
    "conversations",
    SAVED_VIEW_ID,
    "--mailbox",
    MAILBOX_ID,
    "--cursor",
    "cursor-1",
    "--limit",
    "25",
  ]);
  const deleted = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "saved-view",
    "delete",
    SAVED_VIEW_ID,
    "--mailbox",
    MAILBOX_ID,
    "--revision",
    "2",
    "--yes",
  ]);

  expect(created.exitCode).toBe(0);
  expect(listed.exitCode).toBe(0);
  expect(loaded.exitCode).toBe(0);
  expect(updated.exitCode).toBe(0);
  expect(conversations.exitCode).toBe(0);
  expect(deleted.exitCode).toBe(0);
  expect(requests).toEqual([
    {
      method: "POST",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/saved-views`,
      body: { name: "My queue", scope: "private", filter: savedView.filter },
    },
    {
      method: "GET",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/saved-views`,
      body: null,
    },
    {
      method: "GET",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/saved-views/${SAVED_VIEW_ID}`,
      body: null,
    },
    {
      method: "PATCH",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/saved-views/${SAVED_VIEW_ID}`,
      body: { expectedRevision: 1, filter: updatedFilter },
    },
    {
      method: "GET",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/saved-views/${SAVED_VIEW_ID}/conversations?limit=25&cursor=cursor-1`,
      body: null,
    },
    {
      method: "DELETE",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/saved-views/${SAVED_VIEW_ID}`,
      body: { expectedRevision: 2 },
    },
  ]);
}, 45_000);

test("comment add forwards stdin and a message reference", async () => {
  let requestBody: unknown;
  const server = withMailbox(async (request) => {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/comments`
    ) {
      requestBody = await request.json();
      return api({
        id: COMMENT_ID,
        conversationId: CONVERSATION_ID,
        body: "Internal note\n",
        author: { kind: "user", id: USER_ID, displayName: "Writer", avatarHash: null },
        referencedMessageId: MESSAGE_ID,
        revision: 1,
        editedAt: null,
        deletedAt: null,
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(
    `http://127.0.0.1:${server.port}`,
    ["--json", "mail", "comment", "add", CONVERSATION_ID, "--mailbox", MAILBOX_ID, "--body-stdin", "--message", MESSAGE_ID],
    "Internal note\n",
  );

  expect(result.exitCode).toBe(0);
  expect(requestBody).toEqual({
    body: "Internal note\n",
    referencedMessageId: MESSAGE_ID,
  });
});

test("comment delete uses a revisioned tombstone request", async () => {
  let method = "";
  let requestBody: unknown;
  const server = withMailbox(async (request) => {
    if (new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/comments/${COMMENT_ID}`) {
      method = request.method;
      requestBody = await request.json();
      return api({
        id: COMMENT_ID,
        conversationId: CONVERSATION_ID,
        body: null,
        author: { kind: "user", id: USER_ID, displayName: "Writer", avatarHash: null },
        referencedMessageId: null,
        revision: 3,
        editedAt: "2026-07-13T00:00:01.000Z",
        deletedAt: "2026-07-13T00:00:01.000Z",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:01.000Z",
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "comment",
    "delete",
    CONVERSATION_ID,
    COMMENT_ID,
    "--mailbox",
    MAILBOX_ID,
    "--revision",
    "2",
    "--yes",
  ]);

  expect(result.exitCode).toBe(0);
  expect(method).toBe("DELETE");
  expect(requestBody).toEqual({ expectedRevision: 2 });
  expect(JSON.parse(result.stdout)).toMatchObject({ body: null, revision: 3 });
});

test("conversation list forwards a built-in collaboration view", async () => {
  let query = "";
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/conversations`) {
      query = url.search;
      return api({ items: [], nextCursor: null });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "conversation",
    "list",
    "--mailbox",
    MAILBOX_ID,
    "--view",
    "mine",
  ]);

  expect(result.exitCode).toBe(0);
  expect(new URLSearchParams(query).get("view")).toBe("mine");
});

test("conversation get includes shared context and the latest message window", async () => {
  const requested = new Set<string>();
  const summary = {
    summary: "The launch is approved. Waiting for the final checklist.",
    summaryRevision: 3,
    conversationRevision: 7,
  };
  const collaboration = {
    conversationId: CONVERSATION_ID,
    assignee: { id: USER_ID, uid: "ada", displayName: "Ada Lovelace", avatarHash: null },
    workStatus: "waiting",
    snoozedUntil: null,
    revision: 7,
  };
  const tags = {
    conversationId: CONVERSATION_ID,
    conversationRevision: 7,
    tags: [
      {
        id: TAG_ID,
        mailboxId: MAILBOX_ID,
        name: "Launch",
        color: "blue",
        revision: 2,
        createdAt: "2026-08-15T10:00:00.000Z",
        updatedAt: "2026-08-15T10:00:00.000Z",
      },
    ],
  };
  const message = {
    id: MESSAGE_ID,
    subject: "Final checklist",
    messageId: "<final@example.test>",
    internalDate: "2026-08-15T11:00:00.000Z",
    sentAt: "2026-08-15T11:00:00.000Z",
    from: [{ name: "Ada", address: "ada@example.test" }],
    to: [{ name: null, address: "team@example.test" }],
    flags: [],
    keywords: [],
    hydrationStatus: "hydrated",
    remoteAvailable: true,
    folderId: FOLDER_ID,
  };
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    requested.add(`${url.pathname}${url.search}`);
    const root = `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}`;
    if (url.pathname === `${root}/summary`) return api(summary);
    if (url.pathname === `${root}/collaboration`) return api(collaboration);
    if (url.pathname === `${root}/local-tags`) return api(tags);
    if (url.pathname === `${root}/messages`) return api({ items: [message], nextCursor: "older" });
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "conversation",
    "get",
    CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
  ]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    conversationId: CONVERSATION_ID,
    summary: summary.summary,
    summaryRevision: summary.summaryRevision,
    collaboration: {
      assignee: collaboration.assignee,
      workStatus: collaboration.workStatus,
      snoozedUntil: collaboration.snoozedUntil,
      revision: collaboration.revision,
    },
    tags: [{ id: TAG_ID, name: "Launch", color: "blue", revision: 2 }],
    messages: [message],
    messagesTruncated: true,
  });
  expect(requested).toContain(`/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/messages?limit=50&latest=true`);
});

test("command wait polls until a successful terminal state", async () => {
  let reads = 0;
  const server = withMailbox((request) => {
    if (new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands/${COMMAND_ID}`) {
      reads += 1;
      return api(mailCommand(reads === 1 ? "queued" : "confirmed"));
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "command",
    "wait",
    COMMAND_ID,
    "--mailbox",
    MAILBOX_ID,
    "--timeout-seconds",
    "2",
  ]);

  expect(result.exitCode).toBe(0);
  expect(reads).toBe(2);
  expect(JSON.parse(result.stdout).state).toBe("confirmed");
});

test("status reads the aggregate operational health endpoint", async () => {
  const server = withMailbox((request) =>
    new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/health`
      ? api({
          mailboxId: MAILBOX_ID,
          health: "active",
          healthReason: null,
          syncEnabled: true,
          bindings: { total: 2, active: 1, degraded: 1, pending: 0, revoked: 0, lastVerifiedAt: null, rightsSources: { acl: 1 } },
          discovery: { generation: 3, lastAt: null, activeFolders: 4, missingFolders: 1, ambiguousFolders: 0, subscribedFolders: 4 },
          sync: { lastAt: null, lagSeconds: null, runningRuns: 0, failedRuns: 0, folderStates: { current: 4 } },
          hydration: { complete: 20, pending: 2, failed: 1 },
          commands: { states: { confirmed: 3 }, maintenanceQueued: 0 },
          outbox: { states: {} },
          search: { configuredBackend: "auto", pgTextsearchInstalled: false, bm25Ready: false },
        })
      : api({ message: "unexpected" }, { status: 500 }),
  );
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "status", "--mailbox", MAILBOX_ID]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ mailboxId: MAILBOX_ID, bindings: { active: 1 }, discovery: { missingFolders: 1 } });
});

test("operator run submits a durable typed action with the caller idempotency key", async () => {
  let body: unknown;
  const server = withMailbox(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/operator-actions`) {
      body = await request.json();
      return api({ ...mailCommand("queued"), kind: "rebuild_search", idempotencyKey: "operator-rebuild" });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "operator",
    "run",
    "rebuild-search",
    "--mailbox",
    MAILBOX_ID,
    "--idempotency-key",
    "operator-rebuild",
  ]);

  expect(result.exitCode).toBe(0);
  expect(body).toEqual({ kind: "rebuild_search", idempotencyKey: "operator-rebuild" });
  expect(JSON.parse(result.stdout)).toMatchObject({ kind: "rebuild_search", state: "queued" });
});

test("admin operations reads the redacted platform operator endpoint", async () => {
  const server = withMailbox((request) =>
    new URL(request.url).pathname === "/api/mail/admin/operations"
      ? api({
          mailboxes: [platformMailboxSummary],
          mailboxCount: 1,
          withoutAdministratorCount: 0,
          attentionCount: 0,
          generatedAt: "2026-07-21T10:00:00.000Z",
          nextCursor: null,
        })
      : api({ message: "unexpected" }, { status: 500 }),
  );
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "admin", "operations"]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ mailboxes: [{ mailboxId: MAILBOX_ID, coverage: { search: { covered: 1 } } }] });
});

test("admin mailbox list preserves server pagination and recovery counts", async () => {
  let requested = "";
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    requested = `${url.pathname}${url.search}`;
    if (url.pathname === "/api/mail/admin/operations") {
      return api({
        mailboxes: [platformMailboxSummary],
        mailboxCount: 3,
        withoutAdministratorCount: 1,
        attentionCount: 2,
        generatedAt: "2026-07-21T10:00:00.000Z",
        nextCursor: "next-page",
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "admin",
    "mailbox",
    "list",
    "--query",
    "Support",
    "--limit",
    "25",
  ]);

  expect(result.exitCode).toBe(0);
  expect(requested).toBe("/api/mail/admin/operations?limit=25&q=Support");
  expect(JSON.parse(result.stdout)).toMatchObject({
    mailboxCount: 3,
    withoutAdministratorCount: 1,
    nextCursor: "next-page",
  });
});

test("admin mailbox name resolution checks every page for ambiguity", async () => {
  const secondMailboxId = "Mail92";
  const requested: string[] = [];
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    requested.push(`${url.pathname}${url.search}`);
    if (url.pathname !== "/api/mail/admin/operations") {
      return api({ message: "unexpected" }, { status: 500 });
    }
    const firstPage = !url.searchParams.has("cursor");
    return api({
      mailboxes: [
        {
          ...platformMailboxSummary,
          mailboxId: firstPage ? MAILBOX_ID : secondMailboxId,
          mailboxName: "Shared",
        },
      ],
      mailboxCount: 2,
      withoutAdministratorCount: 0,
      attentionCount: 0,
      generatedAt: "2026-07-21T10:00:00.000Z",
      nextCursor: firstPage ? "next-page" : null,
    });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["mail", "admin", "mailbox", "access", "list", "Shared"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Mailbox "Shared" is ambiguous; use its id.');
  expect(requested).toEqual([
    "/api/mail/admin/operations?q=Shared&limit=100",
    "/api/mail/admin/operations?q=Shared&limit=100&cursor=next-page",
  ]);
});

test("admin mailbox resolution finds a short-id and exact-name collision on page two", async () => {
  const requested: string[] = [];
  let accessRequestCount = 0;
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    requested.push(`${url.pathname}${url.search}`);
    if (url.pathname === `/api/mail/admin/mailboxes/${MAILBOX_ID}/access`) {
      accessRequestCount += 1;
      return api([]);
    }
    if (url.pathname !== "/api/mail/admin/operations") return api({ message: "unexpected" }, { status: 500 });
    const firstPage = !url.searchParams.has("cursor");
    return api({
      mailboxes: [
        {
          ...platformMailboxSummary,
          mailboxId: firstPage ? MAILBOX_ID : "Mail02",
          mailboxName: firstPage ? "Support" : MAILBOX_ID,
        },
      ],
      mailboxCount: 2,
      withoutAdministratorCount: 0,
      attentionCount: 0,
      generatedAt: "2026-07-21T10:00:00.000Z",
      nextCursor: firstPage ? "next-page" : null,
    });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["mail", "admin", "mailbox", "access", "list", MAILBOX_ID]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`Mailbox "${MAILBOX_ID}" is ambiguous`);
  expect(requested).toEqual([
    `/api/mail/admin/operations?q=${MAILBOX_ID}&limit=100`,
    `/api/mail/admin/operations?q=${MAILBOX_ID}&limit=100&cursor=next-page`,
  ]);
  expect(accessRequestCount).toBe(0);
});

test("admin mailbox access can repair a service-account grant without mailbox membership", async () => {
  const serviceAccountId = "00000000-0000-4000-8000-000000000090";
  let granted: unknown;
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    const operationsPath = `/api/mail/admin/mailboxes/${MAILBOX_ID}/operations`;
    const accessPath = `/api/mail/admin/mailboxes/${MAILBOX_ID}/access`;
    if (request.method === "GET" && url.pathname === "/api/mail/admin/operations") {
      return api({
        mailboxes: [platformMailboxSummary],
        mailboxCount: 1,
        withoutAdministratorCount: 0,
        attentionCount: 0,
        generatedAt: "2026-07-21T10:00:00.000Z",
        nextCursor: null,
      });
    }
    if (request.method === "GET" && url.pathname === operationsPath) return api(platformMailboxSummary);
    if (request.method === "GET" && url.pathname === accessPath) return api([]);
    if (request.method === "POST" && url.pathname === accessPath) {
      granted = await request.json();
      return api({
        id: "00000000-0000-4000-8000-000000000091",
        principal: { type: "service_account", serviceAccountId },
        permission: "admin",
        displayName: "Mail repair agent",
        createdAt: "2026-07-21T10:00:00.000Z",
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "admin",
    "mailbox",
    "access",
    "set",
    MAILBOX_ID,
    "--service-account",
    serviceAccountId,
    "--permission",
    "admin",
  ]);

  expect(result.exitCode).toBe(0);
  expect(granted).toEqual({
    principal: { type: "service_account", serviceAccountId },
    permission: "admin",
  });
  expect(JSON.parse(result.stdout)).toMatchObject({ action: "created", entry: { permission: "admin" } });
});

test("folder subscription commands enqueue the durable provider change", async () => {
  const requests: unknown[] = [];
  const server = withMailbox(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands`) {
      const body = await request.json();
      requests.push(body);
      return api({ ...mailCommand("queued"), kind: "set_folder_subscription", payload: body });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const subscribed = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "folder",
    "subscribe",
    FOLDER_ID,
    "--mailbox",
    MAILBOX_ID,
  ]);
  const unsubscribed = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "folder",
    "unsubscribe",
    FOLDER_ID,
    "--mailbox",
    MAILBOX_ID,
  ]);

  expect(subscribed.exitCode).toBe(0);
  expect(unsubscribed.exitCode).toBe(0);
  expect(requests).toEqual([
    expect.objectContaining({ kind: "set_folder_subscription", folderId: FOLDER_ID, subscribed: true }),
    expect.objectContaining({ kind: "set_folder_subscription", folderId: FOLDER_ID, subscribed: false }),
  ]);
});

test("rediscover submits a typed durable maintenance command and can wait", async () => {
  const bodies: unknown[] = [];
  let reads = 0;
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands`) {
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);
      return api({ ...mailCommand("queued"), kind: body.kind });
    }
    if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands/${COMMAND_ID}`) {
      reads += 1;
      return api({ ...mailCommand("confirmed"), kind: "discover_folders", result: { bindings: [] } });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "rediscover",
    "--mailbox",
    MAILBOX_ID,
    "--binding",
    CONNECTION_ID,
    "--idempotency-key",
    "rediscovery-test",
    "--wait",
    "--timeout-seconds",
    "2",
  ]);

  expect(result.exitCode).toBe(0);
  expect(reads).toBe(1);
  expect(bodies).toEqual([
    {
      kind: "discover_folders",
      bindingId: CONNECTION_ID,
      idempotencyKey: "rediscovery-test",
    },
  ]);
  expect(JSON.parse(result.stdout)).toMatchObject({ kind: "discover_folders", state: "confirmed" });
});

test("command wait exits non-zero for a terminal failure", async () => {
  const server = withMailbox((request) =>
    new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands/${COMMAND_ID}`
      ? api(mailCommand("failed"))
      : api({ message: "unexpected" }, { status: 500 }),
  );
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["mail", "command", "wait", COMMAND_ID, "--mailbox", MAILBOX_ID]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("SMTP rejected the message");
});

test("command wait has a bounded timeout", async () => {
  const server = withMailbox((request) =>
    new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands/${COMMAND_ID}`
      ? api(mailCommand("queued"))
      : api({ message: "unexpected" }, { status: 500 }),
  );
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "mail",
    "command",
    "wait",
    COMMAND_ID,
    "--mailbox",
    MAILBOX_ID,
    "--timeout-seconds",
    "1",
  ]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`Timed out waiting for mail command ${COMMAND_ID}`);
});

test("command wait aborts an in-flight request at the deadline", async () => {
  const server = withMailbox(async (request) => {
    if (new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands/${COMMAND_ID}`) {
      await Bun.sleep(5_000);
      return api(mailCommand("queued"));
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const startedAt = Date.now();

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "mail",
    "command",
    "wait",
    COMMAND_ID,
    "--mailbox",
    MAILBOX_ID,
    "--timeout-seconds",
    "1",
  ]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`Timed out waiting for mail command ${COMMAND_ID}`);
  expect(Date.now() - startedAt).toBeLessThan(4_500);
});

test("message wait polls indexed search for the expected message", async () => {
  let searches = 0;
  const server = withMailbox(async (request) => {
    if (new URL(request.url).pathname !== `/api/mail/mailboxes/${MAILBOX_ID}/search`) {
      return api({ message: "unexpected" }, { status: 500 });
    }
    searches += 1;
    const body = (await request.json()) as { expression?: unknown };
    expect(body.expression).toEqual({ type: "text", field: "subject", query: "smoke-marker", match: "exact" });
    return api({
      items:
        searches === 1
          ? []
          : [
              {
                id: MESSAGE_ID,
                conversationId: CONVERSATION_ID,
                subject: "smoke-marker",
                messageId: "<smoke-marker@example.com>",
                internalDate: "2026-07-12T00:00:00.000Z",
                sentAt: "2026-07-12T00:00:00.000Z",
                from: [{ name: null, address: "sender@example.com" }],
                to: [{ name: null, address: "recipient@example.com" }],
                flags: [],
                snippet: "body",
                rank: 1,
              },
            ],
      nextCursor: null,
      backend: "native",
    });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "message",
    "wait",
    "--mailbox",
    MAILBOX_ID,
    "--subject",
    "smoke-marker",
    "--match",
    "exact",
    "--timeout-seconds",
    "2",
  ]);

  expect(result.exitCode).toBe(0);
  expect(searches).toBe(2);
  expect(JSON.parse(result.stdout).id).toBe(MESSAGE_ID);
});

test("send carries reply context and can wait for delivery", async () => {
  const bodies: unknown[] = [];
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/drafts`) {
      bodies.push(await request.json());
      return api({
        id: DRAFT_ID,
        mailboxId: MAILBOX_ID,
        conversationId: CONVERSATION_ID,
        senderIdentityId: IDENTITY_ID,
        to: [{ name: null, address: "recipient@example.com" }],
        cc: [],
        bcc: [],
        subject: "Re: CLI test",
        body: "Reply body",
        format: "markdown",
        revision: 1,
        state: "draft",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
      });
    }
    if (request.method === "POST" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands`) {
      bodies.push(await request.json());
      return api(mailCommand("queued"));
    }
    if (request.method === "POST" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/drafts/${DRAFT_ID}/safety-review`) {
      return api({
        draftId: DRAFT_ID,
        revision: 1,
        fingerprint: "a".repeat(64),
        warnings: [],
      });
    }
    if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands/${COMMAND_ID}`) {
      return api(mailCommand("confirmed"));
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(
    `http://127.0.0.1:${server.port}`,
    [
      "--json",
      "mail",
      "send",
      "--mailbox",
      MAILBOX_ID,
      "--identity",
      IDENTITY_ID,
      "--to",
      "recipient@example.com",
      "--conversation",
      CONVERSATION_ID,
      "--subject",
      "Re: CLI test",
      "--body-stdin",
      "--undo",
      "0",
      "--wait",
      "--timeout-seconds",
      "2",
    ],
    "Reply body",
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(bodies[0]).toMatchObject({ conversationId: CONVERSATION_ID, body: "Reply body" });
  expect(bodies[1]).toMatchObject({ kind: "send", expectedDraftRevision: 1, undoSeconds: 0 });
  expect(JSON.parse(result.stdout).command.state).toBe("confirmed");
});

test("send requires explicit approval for the exact safety review", async () => {
  const commandBodies: unknown[] = [];
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/drafts`) {
      return api({
        id: DRAFT_ID,
        mailboxId: MAILBOX_ID,
        conversationId: null,
        senderIdentityId: IDENTITY_ID,
        to: [{ name: null, address: "external@example.net" }],
        cc: [],
        bcc: [],
        subject: "Attachment",
        body: "Please see the attached file.",
        format: "plain",
        revision: 3,
        state: "draft",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
      });
    }
    if (request.method === "POST" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/drafts/${DRAFT_ID}/safety-review`) {
      return api({
        draftId: DRAFT_ID,
        revision: 3,
        fingerprint: "b".repeat(64),
        warnings: [{ id: "missing_attachment", title: "Attachment may be missing", description: "No attachment is included." }],
      });
    }
    if (request.method === "POST" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands`) {
      commandBodies.push(await request.json());
      return api(mailCommand("queued"));
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  const base = [
    "--json",
    "mail",
    "send",
    "--mailbox",
    MAILBOX_ID,
    "--identity",
    IDENTITY_ID,
    "--to",
    "external@example.net",
    "--subject",
    "Attachment",
    "--body-stdin",
  ];
  const rejected = await runCli(origin, base, "Please see the attached file.");
  expect(rejected.exitCode).toBe(1);
  expect(rejected.stderr).toContain("Pass --approve-safety");
  expect(commandBodies).toHaveLength(0);

  const approved = await runCli(origin, [...base, "--approve-safety"], "Please see the attached file.");
  expect(approved.exitCode).toBe(0);
  expect(commandBodies[0]).toMatchObject({
    safetyApproval: {
      revision: 3,
      fingerprint: "b".repeat(64),
      warningIds: ["missing_attachment"],
    },
  });
});

test("message reuse commands create independent idempotent drafts", async () => {
  const requests: unknown[] = [];
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}/derive-draft`) {
      requests.push(await request.json());
      return api({
        id: DRAFT_ID,
        mailboxId: MAILBOX_ID,
        conversationId: null,
        senderIdentityId: IDENTITY_ID,
        to: [{ name: null, address: "recipient@example.com" }],
        cc: [],
        bcc: [],
        subject: "Reusable message",
        body: "Body",
        format: "plain",
        revision: 1,
        state: "draft",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  const commands = [
    ["mail", "message", "edit-as-new", MESSAGE_ID, "--mailbox", MAILBOX_ID, "--identity", IDENTITY_ID, "--idempotency-key", "edit-1"],
    ["mail", "message", "resend", MESSAGE_ID, "--mailbox", MAILBOX_ID, "--identity", IDENTITY_ID, "--idempotency-key", "resend-1"],
  ];
  for (const args of commands) {
    const result = await runCli(origin, args);
    expect(result.exitCode).toBe(0);
  }
  expect(requests).toEqual([
    { kind: "edit_as_new", senderIdentityId: IDENTITY_ID, includeAttachments: true, idempotencyKey: "edit-1" },
    { kind: "resend", senderIdentityId: IDENTITY_ID, includeAttachments: true, idempotencyKey: "resend-1" },
  ]);
});

test("draft create can include source attachments for a forward", async () => {
  let requestBody: unknown;
  const server = withMailbox(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/drafts`) {
      requestBody = await request.json();
      return api({
        id: DRAFT_ID,
        mailboxId: MAILBOX_ID,
        conversationId: CONVERSATION_ID,
        senderIdentityId: IDENTITY_ID,
        to: [],
        cc: [],
        bcc: [],
        subject: "Fwd: CLI test",
        body: "Forward body",
        format: "markdown",
        revision: 1,
        state: "draft",
        attachments: [],
        createdAt: "2026-07-23T00:00:00.000Z",
        updatedAt: "2026-07-23T00:00:00.000Z",
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(
    `http://127.0.0.1:${server.port}`,
    [
      "--json",
      "mail",
      "draft",
      "create",
      "--mailbox",
      MAILBOX_ID,
      "--identity",
      IDENTITY_ID,
      "--conversation",
      CONVERSATION_ID,
      "--intent",
      "forward",
      "--source-message",
      MESSAGE_ID,
      "--include-source-attachments",
      "--subject",
      "Fwd: CLI test",
      "--body-stdin",
    ],
    "Forward body",
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(requestBody).toMatchObject({
    conversationId: CONVERSATION_ID,
    intent: "forward",
    sourceMessageId: MESSAGE_ID,
    includeSourceAttachments: true,
  });
});

test("provider credentials are accepted from stdin and never printed", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = withMailbox(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/connections`) {
      requestBody = (await request.json()) as Record<string, unknown>;
      return api({
        connection: {
          id: CONNECTION_ID,
          mailboxId: MAILBOX_ID,
          name: "Provider",
          email: "sender@example.com",
        },
        verification: {},
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(
    `http://127.0.0.1:${server.port}`,
    [
      "mail",
      "provider",
      "add",
      "--mailbox",
      MAILBOX_ID,
      "--name",
      "Provider",
      "--email",
      "sender@example.com",
      "--username",
      "sender@example.com",
      "--imap-host",
      "imap.example.com",
      "--smtp-host",
      "smtp.example.com",
      "--secret-stdin",
    ],
    "not-a-real-secret",
  );

  expect(result.exitCode).toBe(0);
  expect(requestBody).toMatchObject({ secret: { kind: "password", password: "not-a-real-secret" } });
  expect(requestBody).not.toHaveProperty("owner");
  expect(result.stdout).not.toContain("not-a-real-secret");
  expect(result.stderr).not.toContain("not-a-real-secret");
});

test("provider and attachment-link secrets reject inline values", async () => {
  const server = withMailbox(() => api({ message: "unexpected" }, { status: 500 }));
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  const provider = await runCli(origin, [
    "mail",
    "provider",
    "add",
    "--mailbox",
    MAILBOX_ID,
    "--name",
    "Provider",
    "--email",
    "sender@example.com",
    "--username",
    "sender@example.com",
    "--imap-host",
    "imap.example.com",
    "--smtp-host",
    "smtp.example.com",
    "--secret",
    "inline-provider-secret",
  ]);
  const link = await runCli(origin, [
    "mail",
    "attachment",
    "link",
    "create",
    MESSAGE_ID,
    ATTACHMENT_ID,
    "--mailbox",
    MAILBOX_ID,
    "--source",
    "message",
    "--password",
    "inline-link-secret",
  ]);

  expect(provider.exitCode).toBe(1);
  expect(provider.stderr).toContain("Provider secret cannot be passed inline");
  expect(provider.stderr).not.toContain("inline-provider-secret");
  expect(link.exitCode).toBe(1);
  expect(link.stderr).toContain("Attachment-link password cannot be passed inline");
  expect(link.stderr).not.toContain("inline-link-secret");
});

test("provider OAuth input reports malformed documents before making a connection request", async () => {
  let connectionRequests = 0;
  const server = withMailbox((request) => {
    if (request.method === "POST") connectionRequests += 1;
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(
    `http://127.0.0.1:${server.port}`,
    [
      "mail",
      "provider",
      "add",
      "--mailbox",
      MAILBOX_ID,
      "--name",
      "Provider",
      "--email",
      "sender@example.com",
      "--username",
      "sender@example.com",
      "--imap-host",
      "imap.example.com",
      "--smtp-host",
      "smtp.example.com",
      "--oauth2",
      "--secret-stdin",
    ],
    "not-json",
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Provider OAuth secret must be valid JSON");
  expect(connectionRequests).toBe(0);
});

test("send validates offset-aware schedules before creating a draft", async () => {
  let sideEffects = 0;
  const server = withMailbox((request) => {
    if (request.method !== "GET") sideEffects += 1;
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "mail",
    "send",
    "--mailbox",
    MAILBOX_ID,
    "--identity",
    IDENTITY_ID,
    "--to",
    "recipient@example.com",
    "--subject",
    "Scheduled",
    "--body",
    "Body",
    "--schedule",
    "2026-07-22T10:00:00",
  ]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--schedule must be an ISO date-time with a UTC offset");
  expect(sideEffects).toBe(0);
});

test("command list rejects limits above the service maximum", async () => {
  const server = withMailbox(() => api({ message: "unexpected" }, { status: 500 }));
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["mail", "command", "list", "--mailbox", MAILBOX_ID, "--limit", "101"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("must be at most 100");
});

test("binding attach sends only the mailbox connection id", async () => {
  let requestBody: unknown;
  const binding = {
    id: BINDING_ID,
    mailboxId: MAILBOX_ID,
    connectionId: CONNECTION_ID,
    state: "active",
    authenticatedPrincipal: "sender@example.com",
    capabilities: {},
    lastVerifiedAt: "2026-07-12T00:00:00.000Z",
    lastError: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const server = withMailbox(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/bindings`) {
      requestBody = await request.json();
      return api(binding);
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "binding",
    "attach",
    CONNECTION_ID,
    "--mailbox",
    MAILBOX_ID,
  ]);

  expect(result.exitCode).toBe(0);
  expect(requestBody).toEqual({ connectionId: CONNECTION_ID });
  expect(JSON.parse(result.stdout)).toEqual(binding);
});

test("attachment download writes the exact response bytes", async () => {
  const expected = new TextEncoder().encode("attachment bytes\n");
  const output = `/tmp/cloud-mail-cli-${crypto.randomUUID()}.txt`;
  temporaryFiles.push(output);
  const server = withMailbox((request) => {
    const expectedPath = `/api/mail/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}`;
    if (new URL(request.url).pathname === expectedPath) {
      return new Response(expected, { headers: { "Content-Type": "text/plain", ETag: '"attachment-etag"' } });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "attachment",
    "download",
    MESSAGE_ID,
    ATTACHMENT_ID,
    "--mailbox",
    MAILBOX_ID,
    "--out",
    output,
  ]);

  expect(result.exitCode).toBe(0);
  expect(new Uint8Array(await readFile(output))).toEqual(expected);
  expect(JSON.parse(result.stdout)).toMatchObject({ path: output, bytes: expected.byteLength, contentType: "text/plain" });
});

test("message inspect and source expose metadata and exact RFC bytes", async () => {
  const expected = new TextEncoder().encode("Message-ID: <cli@example.test>\r\n\r\nCLI source\r\n");
  const output = `/tmp/cloud-mail-cli-${crypto.randomUUID()}.eml`;
  temporaryFiles.push(output);
  const inspector = {
    id: MESSAGE_ID,
    messageId: "<cli@example.test>",
    inReplyTo: null,
    referenceIds: [],
    subject: "CLI inspector",
    internalDate: "2026-07-23T12:00:00.000Z",
    sentAt: "2026-07-23T12:00:00.000Z",
    sizeBytes: expected.byteLength,
    hydrationStatus: "complete",
    hydrationErrorCode: null,
    contentHash: "a".repeat(64),
    sourceHash: "b".repeat(64),
    contentType: "text/plain",
    source: {
      available: true,
      exact: true,
      byteLength: expected.byteLength,
      contentHash: "b".repeat(64),
    },
    headers: [{ name: "Message-ID", value: "<cli@example.test>" }],
    rawHeaders: "Message-ID: <cli@example.test>",
    headersComplete: true,
    placements: [],
    parts: [],
    attachments: [],
    mailingList: null,
    spam: { flag: null, status: null, score: null },
    warnings: [],
  };
  const server = withMailbox((request) => {
    const pathname = new URL(request.url).pathname;
    const base = `/api/mail/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}`;
    if (pathname === `${base}/inspector`) return api(inspector);
    if (pathname === `${base}/source`) {
      return new Response(expected, {
        headers: {
          "Content-Type": "message/rfc822",
          "Content-Length": String(expected.byteLength),
          ETag: '"source-etag"',
        },
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  const inspected = await runCli(origin, ["--json", "mail", "message", "inspect", MESSAGE_ID, "--mailbox", MAILBOX_ID]);
  expect(inspected.exitCode).toBe(0);
  expect(inspected.stderr).toBe("");
  expect(JSON.parse(inspected.stdout)).toEqual(inspector);

  const downloaded = await runCli(origin, ["--json", "mail", "message", "source", MESSAGE_ID, "--mailbox", MAILBOX_ID, "--out", output]);
  expect(downloaded.exitCode).toBe(0);
  expect(downloaded.stderr).toBe("");
  expect(new Uint8Array(await readFile(output))).toEqual(expected);
  expect(JSON.parse(downloaded.stdout)).toMatchObject({
    path: output,
    bytes: expected.byteLength,
    contentType: "message/rfc822",
    etag: '"source-etag"',
  });
});

test("attachment link create supports message and draft API paths without echoing passwords", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const created = {
    link: {
      id: ATTACHMENT_LINK_ID,
      mailboxId: MAILBOX_ID,
      sourceKind: "message",
      sourceId: MESSAGE_ID,
      filename: "invoice.pdf",
      contentType: "application/pdf",
      byteLength: 42,
      passwordProtected: true,
      expiresAt: "2026-08-01T12:00:00.000Z",
      revokedAt: null,
      downloadCount: 0,
      maxDownloads: 3,
      lastDownloadedAt: null,
      createdAt: "2026-07-21T10:00:00.000Z",
    },
    url: "https://cloud.example/public/mail/attachments/one-time-token",
  };
  const server = withMailbox(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/links")) {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() });
      return api({ ...created, link: { ...created.link, sourceKind: requests.length === 1 ? "message" : "draft" } });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const messageResult = await runCli(
    `http://127.0.0.1:${server.port}`,
    [
      "--json",
      "mail",
      "attachment",
      "link",
      "create",
      MESSAGE_ID,
      ATTACHMENT_ID,
      "--mailbox",
      MAILBOX_ID,
      "--source",
      "message",
      "--password-stdin",
      "--expires-at",
      "2026-08-01T12:00:00Z",
      "--max-downloads",
      "3",
    ],
    " leading and trailing spaces \n",
  );
  const draftResult = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "attachment",
    "link",
    "create",
    DRAFT_ID,
    ATTACHMENT_ID,
    "--mailbox",
    MAILBOX_ID,
    "--source",
    "draft",
  ]);

  expect(messageResult.exitCode).toBe(0);
  expect(draftResult.exitCode).toBe(0);
  expect(requests).toEqual([
    {
      path: `/api/mail/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}/links`,
      body: {
        password: " leading and trailing spaces ",
        expiresAt: "2026-08-01T12:00:00.000Z",
        maxDownloads: 3,
      },
    },
    {
      path: `/api/mail/mailboxes/${MAILBOX_ID}/drafts/${DRAFT_ID}/attachments/${ATTACHMENT_ID}/links`,
      body: {},
    },
  ]);
  expect(JSON.parse(messageResult.stdout)).toEqual(created);
  expect(messageResult.stdout).not.toContain("leading and trailing spaces");
  expect(messageResult.stderr).not.toContain("leading and trailing spaces");
});

test("attachment link list exposes pagination and revoke requires confirmation", async () => {
  let revokeRequested = false;
  const link = {
    id: ATTACHMENT_LINK_ID,
    mailboxId: MAILBOX_ID,
    sourceKind: "message",
    sourceId: MESSAGE_ID,
    filename: "invoice.pdf",
    contentType: "application/pdf",
    byteLength: 42,
    passwordProtected: false,
    expiresAt: null,
    revokedAt: null,
    downloadCount: 1,
    maxDownloads: 3,
    lastDownloadedAt: "2026-07-21T10:05:00.000Z",
    createdAt: "2026-07-21T10:00:00.000Z",
  };
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/attachment-links`) {
      expect(url.searchParams.get("limit")).toBe("17");
      expect(url.searchParams.get("cursor")).toBe("older-links");
      return api({ items: [link], nextCursor: "oldest-page" });
    }
    if (request.method === "DELETE" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/attachment-links/${ATTACHMENT_LINK_ID}`) {
      revokeRequested = true;
      return api({ ...link, revokedAt: "2026-07-21T10:10:00.000Z" });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const listed = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "attachment",
    "link",
    "list",
    "--mailbox",
    MAILBOX_ID,
    "--limit",
    "17",
    "--cursor",
    "older-links",
  ]);
  const unconfirmed = await runCli(`http://127.0.0.1:${server.port}`, [
    "mail",
    "attachment",
    "link",
    "revoke",
    ATTACHMENT_LINK_ID,
    "--mailbox",
    MAILBOX_ID,
  ]);
  expect(revokeRequested).toBe(false);
  const revoked = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "attachment",
    "link",
    "revoke",
    ATTACHMENT_LINK_ID,
    "--mailbox",
    MAILBOX_ID,
    "--yes",
  ]);

  expect(listed.exitCode).toBe(0);
  expect(JSON.parse(listed.stdout)).toEqual({ items: [link], nextCursor: "oldest-page" });
  expect(unconfirmed.exitCode).not.toBe(0);
  expect(unconfirmed.stderr).toContain("Pass --yes");
  expect(revoked.exitCode).toBe(0);
  expect(revokeRequested).toBe(true);
  expect(JSON.parse(revoked.stdout)).toEqual({ ...link, revokedAt: "2026-07-21T10:10:00.000Z" });
}, 15_000);

test("admin storage commands preserve snapshot and queued reconciliation contracts", async () => {
  const snapshot = {
    mailboxes: [
      {
        mailboxId: MAILBOX_ID,
        mailboxName: "Support",
        messageCount: 4,
        messageBytes: 1_000,
        receivedAttachmentBytes: 200,
        draftAttachmentBytes: 300,
        externalLinkBytes: 200,
        logicalTotalBytes: 1_300,
        calculatedAt: "2026-07-21T10:00:00.000Z",
      },
    ],
    physicalDatabaseBytes: 2_000,
    physicalBlobBytes: 500,
    calculatedAt: "2026-07-21T10:00:00.000Z",
  };
  const requests: string[] = [];
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);
    if (request.method === "GET" && url.pathname === "/api/mail/admin/storage") return api(snapshot);
    if (request.method === "POST" && url.pathname === "/api/mail/admin/storage/reconcile") return api({ queued: true });
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const shown = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "admin", "storage", "show"]);
  const reconciled = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "admin", "storage", "reconcile"]);

  expect(shown.exitCode).toBe(0);
  expect(reconciled.exitCode).toBe(0);
  expect(JSON.parse(shown.stdout)).toEqual(snapshot);
  expect(JSON.parse(reconciled.stdout)).toEqual({ queued: true });
  expect(requests).toEqual(["GET /api/mail/admin/storage", "POST /api/mail/admin/storage/reconcile"]);
});

test("message deletion requires explicit confirmation before the API call", async () => {
  let mutationRequested = false;
  const server = withMailbox(() => {
    mutationRequested = true;
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "mail",
    "message",
    "delete",
    ATTACHMENT_ID,
    "--mailbox",
    MAILBOX_ID,
    "--folder",
    CONVERSATION_ID,
  ]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Pass --yes");
  expect(mutationRequested).toBe(false);
});

test("send cancellation uses the public command id", async () => {
  let requestedPath = "";
  const server = withMailbox((request) => {
    requestedPath = new URL(request.url).pathname;
    return api(null);
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "command",
    "cancel",
    COMMAND_ID,
    "--mailbox",
    MAILBOX_ID,
  ]);

  expect(result.exitCode).toBe(0);
  expect(requestedPath).toBe(`/api/mail/mailboxes/${MAILBOX_ID}/commands/${COMMAND_ID}/cancel`);
  expect(JSON.parse(result.stdout)).toEqual({ cancelled: true, commandId: COMMAND_ID });
});

test("scheduled sends expose list and explicit cancellation disposition", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/scheduled-sends`) {
      return api({
        items: [
          {
            id: SCHEDULED_SEND_ID,
            commandId: COMMAND_ID,
            draftId: DRAFT_ID,
            conversationId: null,
            intent: "new",
            to: [{ name: null, address: "recipient@example.com" }],
            cc: [],
            bcc: [],
            subject: "Later",
            bodyPreview: "Scheduled body",
            scheduledAt: "2026-07-18T12:00:00.000Z",
            nextAttemptAt: null,
            state: "scheduled",
            attempt: 0,
            lastError: null,
            scheduledBy: { kind: "user", displayName: "Mail User" },
            createdAt: "2026-07-18T10:00:00.000Z",
          },
        ],
        nextCursor: null,
        total: 1,
      });
    }
    if (request.method === "POST" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/scheduled-sends/${SCHEDULED_SEND_ID}/cancel`) {
      requests.push({ method: request.method, path: url.pathname, body: await request.json() });
      return api({ disposition: "discard", draftId: DRAFT_ID });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const listed = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "scheduled", "list", "--mailbox", MAILBOX_ID]);
  expect(listed.exitCode).toBe(0);
  expect(JSON.parse(listed.stdout)).toMatchObject({ total: 1, items: [{ id: SCHEDULED_SEND_ID }] });

  const cancelled = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "scheduled",
    "cancel",
    SCHEDULED_SEND_ID,
    "--mailbox",
    MAILBOX_ID,
    "--discard",
    "--yes",
  ]);
  expect(cancelled.exitCode).toBe(0);
  expect(JSON.parse(cancelled.stdout)).toEqual({ disposition: "discard", draftId: DRAFT_ID });
  expect(requests).toEqual([
    {
      method: "POST",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/scheduled-sends/${SCHEDULED_SEND_ID}/cancel`,
      body: { disposition: "discard" },
    },
  ]);
});

test("folder create submits one durable provider command and waits for rediscovery", async () => {
  let body: unknown;
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands`) {
      body = await request.json();
      return api({ ...mailCommand("queued"), kind: "create_folder" });
    }
    if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands/${COMMAND_ID}`) {
      return api({ ...mailCommand("confirmed"), kind: "create_folder", result: { path: "Cloud Smoke" } });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "folder",
    "create",
    "Cloud Smoke",
    "--mailbox",
    MAILBOX_ID,
    "--parent",
    FOLDER_ID,
    "--hide-in-sidebar",
    "--idempotency-key",
    "folder-create-test",
    "--wait",
    "--timeout-seconds",
    "2",
  ]);

  expect(result.exitCode).toBe(0);
  expect(body).toEqual({
    kind: "create_folder",
    parentFolderId: FOLDER_ID,
    name: "Cloud Smoke",
    subscribe: true,
    showInSidebar: false,
    idempotencyKey: "folder-create-test",
  });
  expect(JSON.parse(result.stdout)).toMatchObject({ kind: "create_folder", state: "confirmed" });
});

test("folder hide changes only Cloud Mail sidebar visibility", async () => {
  let body: unknown;
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (request.method === "PATCH" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/folders/${FOLDER_ID}`) {
      body = await request.json();
      return api({ folderId: FOLDER_ID, showInSidebar: false });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "folder", "hide", FOLDER_ID, "--mailbox", MAILBOX_ID]);

  expect(result.exitCode).toBe(0);
  expect(body).toEqual({ showInSidebar: false });
  expect(JSON.parse(result.stdout)).toEqual({ folderId: FOLDER_ID, showInSidebar: false });
});

test("message read uses an additive state command", async () => {
  let body: unknown;
  const server = withMailbox(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands`) {
      body = await request.json();
      return api({ ...mailCommand("queued"), kind: "change_message_state" });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "message",
    "read",
    MESSAGE_ID,
    "--mailbox",
    MAILBOX_ID,
    "--folder",
    FOLDER_ID,
    "--idempotency-key",
    "message-read-test",
  ]);

  expect(result.exitCode).toBe(0);
  expect(body).toEqual({
    kind: "change_message_state",
    messageId: MESSAGE_ID,
    folderId: FOLDER_ID,
    change: { addFlags: ["seen"] },
    idempotencyKey: "message-read-test",
  });
});

test("provider message mutations send public message ids", async () => {
  const bodies: unknown[] = [];
  const server = withMailbox(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/commands`) {
      bodies.push(await request.json());
      return api({ ...mailCommand("queued"), kind: "move" });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const shared = ["--mailbox", MAILBOX_ID] as const;
  const results = await Promise.all([
    runCli(`http://127.0.0.1:${server.port}`, [
      "--json",
      "mail",
      "message",
      "flags",
      MESSAGE_ID,
      ...shared,
      "--folder",
      FOLDER_ID,
      "--flag",
      "\\Seen",
      "--idempotency-key",
      "flags-test",
    ]),
    runCli(`http://127.0.0.1:${server.port}`, [
      "--json",
      "mail",
      "message",
      "move",
      MESSAGE_ID,
      ...shared,
      "--source",
      FOLDER_ID,
      "--destination",
      "Foldr2",
      "--idempotency-key",
      "move-test",
    ]),
    runCli(`http://127.0.0.1:${server.port}`, [
      "--json",
      "mail",
      "message",
      "copy",
      MESSAGE_ID,
      ...shared,
      "--source",
      FOLDER_ID,
      "--destination",
      "Foldr2",
      "--idempotency-key",
      "copy-test",
    ]),
    runCli(`http://127.0.0.1:${server.port}`, [
      "--json",
      "mail",
      "message",
      "delete",
      MESSAGE_ID,
      ...shared,
      "--folder",
      FOLDER_ID,
      "--idempotency-key",
      "delete-test",
      "--yes",
    ]),
  ]);

  expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0, 0]);
  expect(bodies).toHaveLength(4);
  expect(bodies).toEqual(
    expect.arrayContaining([
      { kind: "set_flags", messageId: MESSAGE_ID, folderId: FOLDER_ID, flags: ["\\Seen"], idempotencyKey: "flags-test" },
      { kind: "move", messageId: MESSAGE_ID, sourceFolderId: FOLDER_ID, destinationFolderId: "Foldr2", idempotencyKey: "move-test" },
      { kind: "copy", messageId: MESSAGE_ID, sourceFolderId: FOLDER_ID, destinationFolderId: "Foldr2", idempotencyKey: "copy-test" },
      { kind: "delete", messageId: MESSAGE_ID, folderId: FOLDER_ID, idempotencyKey: "delete-test" },
    ]),
  );
});

test("conversation message table does not expose provider placement ids", async () => {
  const placementId = "00000000-0000-4000-8000-000000000099";
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/messages`) {
      return api({
        items: [
          {
            id: MESSAGE_ID,
            subject: "Public contract",
            internalDate: "2026-07-12T00:00:00.000Z",
            from: [{ name: null, address: "sender@example.test" }],
            remoteMessageRefId: placementId,
          },
        ],
        nextCursor: null,
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "mail",
    "conversation",
    "messages",
    CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(MESSAGE_ID);
  expect(result.stdout).not.toContain(placementId);
  expect(result.stdout).not.toContain("REMOTE REF");
});

test("conversation archive targets the configured semantic role", async () => {
  let body: unknown;
  const server = withMailbox(async (request) => {
    const expectedPath = `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/actions`;
    if (request.method === "POST" && new URL(request.url).pathname === expectedPath) {
      body = await request.json();
      return api({ correlationId: "archive-correlation", commands: [{ ...mailCommand("queued"), kind: "move" }] });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "conversation",
    "archive",
    CONVERSATION_ID,
    "--mailbox",
    MAILBOX_ID,
    "--source",
    FOLDER_ID,
    "--idempotency-key",
    "conversation-archive-test",
  ]);

  expect(result.exitCode).toBe(0);
  expect(body).toEqual({
    kind: "move_to_role",
    sourceFolderId: FOLDER_ID,
    role: "archive",
    idempotencyKey: "conversation-archive-test",
  });
  expect(JSON.parse(result.stdout)).toMatchObject({ correlationId: "archive-correlation", commands: [{ kind: "move" }] });
});

test("conversation not-spam and provider keyword commands use the shared triage API", async () => {
  const bodies: unknown[] = [];
  const server = withMailbox(async (request) => {
    const expectedPath = `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/actions`;
    if (request.method === "POST" && new URL(request.url).pathname === expectedPath) {
      bodies.push(await request.json());
      return api({ correlationId: `correlation-${bodies.length}`, commands: [{ ...mailCommand("queued"), kind: "change_message_state" }] });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  const sharedFlags = ["--mailbox", MAILBOX_ID, "--source", FOLDER_ID];

  const results = [
    await runCli(origin, [
      "--json",
      "mail",
      "conversation",
      "not-spam",
      CONVERSATION_ID,
      ...sharedFlags,
      "--idempotency-key",
      "not-spam-test",
    ]),
    await runCli(origin, [
      "--json",
      "mail",
      "conversation",
      "keyword",
      "add",
      CONVERSATION_ID,
      "FollowUp",
      ...sharedFlags,
      "--idempotency-key",
      "keyword-add-test",
    ]),
    await runCli(origin, [
      "--json",
      "mail",
      "conversation",
      "keyword",
      "remove",
      CONVERSATION_ID,
      "FollowUp",
      ...sharedFlags,
      "--idempotency-key",
      "keyword-remove-test",
    ]),
  ];

  expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0]);
  expect(bodies).toEqual([
    {
      kind: "move_to_role",
      sourceFolderId: FOLDER_ID,
      role: "inbox",
      idempotencyKey: "not-spam-test",
    },
    {
      kind: "change_state",
      sourceFolderId: FOLDER_ID,
      change: { addKeywords: ["FollowUp"] },
      idempotencyKey: "keyword-add-test",
    },
    {
      kind: "change_state",
      sourceFolderId: FOLDER_ID,
      change: { removeKeywords: ["FollowUp"] },
      idempotencyKey: "keyword-remove-test",
    },
  ]);
});

test("conversation move targets an explicit provider folder", async () => {
  let body: unknown;
  const destinationFolderId = "Foldr2";
  const server = withMailbox(async (request) => {
    const expectedPath = `/api/mail/mailboxes/${MAILBOX_ID}/conversations/${CONVERSATION_ID}/actions`;
    if (request.method === "POST" && new URL(request.url).pathname === expectedPath) {
      body = await request.json();
      return api({ correlationId: "move-correlation", commands: [{ ...mailCommand("queued"), kind: "move" }] });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "conversation",
    "move",
    CONVERSATION_ID,
    destinationFolderId,
    "--mailbox",
    MAILBOX_ID,
    "--source",
    FOLDER_ID,
    "--idempotency-key",
    "conversation-move-test",
  ]);

  expect(result.exitCode).toBe(0);
  expect(body).toEqual({
    kind: "move_to_folder",
    sourceFolderId: FOLDER_ID,
    destinationFolderId,
    idempotencyKey: "conversation-move-test",
  });
  expect(JSON.parse(result.stdout)).toMatchObject({ correlationId: "move-correlation", commands: [{ kind: "move" }] });
});

test("draft attachment add resumes a chunked upload and finalizes at the expected revision", async () => {
  const path = `/tmp/cloud-mail-draft-attachment-${crypto.randomUUID()}.txt`;
  const bytes = Buffer.from("streamed draft attachment\n");
  await writeFile(path, bytes);
  temporaryFiles.push(path);
  let uploaded = Buffer.alloc(0);
  let createBody: unknown;
  let finalizeBody: unknown;
  let offset: string | null = null;
  const server = withMailbox(async (request) => {
    const uploadBase = `/api/mail/mailboxes/${MAILBOX_ID}/drafts/${DRAFT_ID}/attachment-uploads`;
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === uploadBase) {
      createBody = await request.json();
      return api({
        id: UPLOAD_ID,
        draftId: DRAFT_ID,
        filename: "upload.txt",
        contentType: "text/plain",
        byteLength: bytes.length,
        receivedBytes: 0,
        chunkSize: 1024 * 1024,
        state: "uploading",
        attachmentId: null,
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
      });
    }
    if (request.method === "PATCH" && url.pathname === `${uploadBase}/${UPLOAD_ID}`) {
      offset = url.searchParams.get("offset");
      uploaded = Buffer.from(await request.arrayBuffer());
      return api({
        id: UPLOAD_ID,
        draftId: DRAFT_ID,
        filename: "upload.txt",
        contentType: "text/plain",
        byteLength: bytes.length,
        receivedBytes: bytes.length,
        chunkSize: 1024 * 1024,
        state: "uploaded",
        attachmentId: null,
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:01.000Z",
      });
    }
    if (request.method === "POST" && url.pathname === `${uploadBase}/${UPLOAD_ID}/finalize`) {
      finalizeBody = await request.json();
      return api({
        id: DRAFT_ID,
        mailboxId: MAILBOX_ID,
        conversationId: null,
        senderIdentityId: IDENTITY_ID,
        to: [],
        cc: [],
        bcc: [],
        subject: "Attachment",
        body: "Body",
        format: "plain",
        attachments: [
          {
            id: ATTACHMENT_ID,
            filename: "upload.txt",
            contentType: "text/plain",
            byteLength: bytes.length,
            contentHash: "a".repeat(64),
            position: 0,
            createdAt: "2026-07-12T00:00:00.000Z",
          },
        ],
        revision: 4,
        state: "draft",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:01.000Z",
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "draft",
    "attachment",
    "add",
    DRAFT_ID,
    path,
    "--mailbox",
    MAILBOX_ID,
    "--revision",
    "3",
    "--name",
    "upload.txt",
    "--content-type",
    "text/plain",
  ]);

  expect(result.exitCode).toBe(0);
  expect(uploaded).toEqual(bytes);
  expect(createBody).toEqual({ filename: "upload.txt", contentType: "text/plain", byteLength: bytes.length });
  expect(String(offset)).toBe("0");
  expect(finalizeBody).toEqual({ expectedRevision: 3 });
  expect(JSON.parse(result.stdout)).toMatchObject({ revision: 4, attachments: [{ id: ATTACHMENT_ID }] });
});

test("draft lease commands expose the complete advisory lease lifecycle", async () => {
  const requests: Array<{ method: string; body: unknown }> = [];
  const lease = {
    holder: { kind: "user", id: USER_ID, displayName: "Mail User", avatarHash: null },
    acquiredAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2026-07-12T00:00:30.000Z",
  };
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== `/api/mail/mailboxes/${MAILBOX_ID}/drafts/${DRAFT_ID}/lease`) {
      return api({ message: "unexpected" }, { status: 500 });
    }
    const body = request.method === "GET" ? null : await request.json();
    requests.push({ method: request.method, body });
    if (request.method === "GET" || request.method === "DELETE") return api(null);
    return api({ ...lease, token: UPLOAD_ID });
  });
  servers.push(server);
  const serverUrl = `http://127.0.0.1:${server.port}`;

  const getResult = await runCli(serverUrl, ["--json", "mail", "draft", "lease", "get", DRAFT_ID, "--mailbox", MAILBOX_ID]);
  const acquireResult = await runCli(serverUrl, [
    "--json",
    "mail",
    "draft",
    "lease",
    "acquire",
    DRAFT_ID,
    "--mailbox",
    MAILBOX_ID,
    "--takeover",
  ]);
  const heartbeatResult = await runCli(serverUrl, [
    "--json",
    "mail",
    "draft",
    "lease",
    "heartbeat",
    DRAFT_ID,
    "--mailbox",
    MAILBOX_ID,
    "--token",
    UPLOAD_ID,
  ]);
  const releaseResult = await runCli(serverUrl, [
    "--json",
    "mail",
    "draft",
    "lease",
    "release",
    DRAFT_ID,
    "--mailbox",
    MAILBOX_ID,
    "--token",
    UPLOAD_ID,
  ]);

  expect([getResult.exitCode, acquireResult.exitCode, heartbeatResult.exitCode, releaseResult.exitCode]).toEqual([0, 0, 0, 0]);
  expect(JSON.parse(getResult.stdout)).toBeNull();
  expect(JSON.parse(acquireResult.stdout)).toMatchObject({ token: UPLOAD_ID });
  expect(JSON.parse(heartbeatResult.stdout)).toMatchObject({ token: UPLOAD_ID });
  expect(JSON.parse(releaseResult.stdout)).toEqual({ released: true, draftId: DRAFT_ID });
  expect(requests).toEqual([
    { method: "GET", body: null },
    { method: "POST", body: { takeover: true } },
    { method: "PUT", body: { token: UPLOAD_ID } },
    { method: "DELETE", body: { token: UPLOAD_ID } },
  ]);
});

test("draft recovery restore owns and releases a lease around the mutation", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    const body = await request.json();
    requests.push({ method: request.method, path: url.pathname, body });
    const leasePath = `/api/mail/mailboxes/${MAILBOX_ID}/drafts/${DRAFT_ID}/lease`;
    if (request.method === "POST" && url.pathname === leasePath) {
      return api({
        holder: { kind: "user", id: USER_ID, displayName: "Mail User", avatarHash: null },
        acquiredAt: "2026-07-12T00:00:00.000Z",
        expiresAt: "2026-07-12T00:00:30.000Z",
        token: UPLOAD_ID,
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/drafts/${DRAFT_ID}/recovery-copies/${ATTACHMENT_ID}/restore`
    ) {
      return api({ id: DRAFT_ID, revision: 4 });
    }
    if (request.method === "DELETE" && url.pathname === leasePath) return api(null);
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "draft",
    "recovery",
    "restore",
    DRAFT_ID,
    ATTACHMENT_ID,
    "--mailbox",
    MAILBOX_ID,
    "--revision",
    "3",
  ]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ id: DRAFT_ID, revision: 4 });
  expect(requests).toEqual([
    {
      method: "POST",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/drafts/${DRAFT_ID}/lease`,
      body: { takeover: false },
    },
    {
      method: "POST",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/drafts/${DRAFT_ID}/recovery-copies/${ATTACHMENT_ID}/restore`,
      body: { expectedRevision: 3, leaseToken: UPLOAD_ID },
    },
    {
      method: "DELETE",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/drafts/${DRAFT_ID}/lease`,
      body: { token: UPLOAD_ID },
    },
  ]);
});

test("draft upload commands make resumable uploads discoverable and cancellable", async () => {
  const activeUpload = {
    id: UPLOAD_ID,
    draftId: DRAFT_ID,
    filename: "upload.txt",
    contentType: "text/plain",
    byteLength: 100,
    receivedBytes: 50,
    chunkSize: 1024 * 1024,
    state: "uploading",
    attachmentId: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:01.000Z",
  };
  const methods: string[] = [];
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    const base = `/api/mail/mailboxes/${MAILBOX_ID}/drafts/${DRAFT_ID}/attachment-uploads`;
    methods.push(request.method);
    if (request.method === "GET" && url.pathname === base) return api([activeUpload]);
    if (request.method === "DELETE" && url.pathname === `${base}/${UPLOAD_ID}`) {
      return api({ ...activeUpload, state: "cancelled" });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const serverUrl = `http://127.0.0.1:${server.port}`;

  const listResult = await runCli(serverUrl, [
    "--json",
    "mail",
    "draft",
    "attachment",
    "upload",
    "list",
    DRAFT_ID,
    "--mailbox",
    MAILBOX_ID,
  ]);
  const cancelResult = await runCli(serverUrl, [
    "--json",
    "mail",
    "draft",
    "attachment",
    "upload",
    "cancel",
    DRAFT_ID,
    UPLOAD_ID,
    "--mailbox",
    MAILBOX_ID,
    "--yes",
  ]);

  expect([listResult.exitCode, cancelResult.exitCode]).toEqual([0, 0]);
  expect(JSON.parse(listResult.stdout)).toEqual([activeUpload]);
  expect(JSON.parse(cancelResult.stdout)).toMatchObject({ id: UPLOAD_ID, state: "cancelled" });
  expect(methods).toEqual(["GET", "DELETE"]);
});

test("default sender setup preserves an existing display name when no name is passed", async () => {
  let body: unknown;
  const server = withMailbox(async (request) => {
    const expectedPath = `/api/mail/mailboxes/${MAILBOX_ID}/sender-identities/default/setup`;
    if (request.method === "POST" && new URL(request.url).pathname === expectedPath) {
      body = await request.json();
      return api({
        id: IDENTITY_ID,
        mailboxId: MAILBOX_ID,
        label: "Existing sender",
        displayName: "Existing sender",
        fromAddress: "sender@example.com",
        replyTo: null,
        defaultCc: [],
        envelopeSender: null,
        defaultSignatureTemplateId: null,
        authenticationPolicy: { automation: "disabled" },
        sentFolderId: FOLDER_ID,
        draftsFolderId: null,
        isDefault: true,
        status: "verified",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:01.000Z",
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "identity",
    "setup-default",
    CONNECTION_ID,
    "--mailbox",
    MAILBOX_ID,
  ]);

  expect(result.exitCode).toBe(0);
  expect(body).toEqual({ bindingId: CONNECTION_ID, savesSentAutomatically: false });
  expect(JSON.parse(result.stdout)).toMatchObject({ displayName: "Existing sender", status: "verified" });
});

test("sender creation keeps the default automation policy unless explicitly disabled", async () => {
  const bodies: unknown[] = [];
  const server = withMailbox(async (request) => {
    const expectedPath = `/api/mail/mailboxes/${MAILBOX_ID}/sender-identities`;
    if (request.method === "POST" && new URL(request.url).pathname === expectedPath) {
      bodies.push(await request.json());
      return api({
        id: IDENTITY_ID,
        mailboxId: MAILBOX_ID,
        label: "Work",
        displayName: "",
        fromAddress: "sender@example.com",
        replyTo: null,
        defaultCc: [],
        envelopeSender: null,
        defaultSignatureTemplateId: null,
        authenticationPolicy: { automation: bodies.length === 1 ? "mailbox" : "disabled" },
        sentFolderId: null,
        draftsFolderId: null,
        isDefault: false,
        status: "unverified",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:01.000Z",
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const defaultResult = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "identity",
    "add",
    "--mailbox",
    MAILBOX_ID,
    "--label",
    "Work",
    "--address",
    "sender@example.com",
  ]);
  const disabledResult = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "identity",
    "add",
    "--mailbox",
    MAILBOX_ID,
    "--label",
    "Work",
    "--address",
    "sender@example.com",
    "--automation",
    "disabled",
  ]);

  expect([defaultResult.exitCode, disabledResult.exitCode]).toEqual([0, 0]);
  expect(bodies).toEqual([
    {
      label: "Work",
      displayName: "",
      fromAddress: "sender@example.com",
      defaultCc: [],
      defaultBcc: [],
      defaultSignatureTemplateId: null,
      isDefault: false,
    },
    {
      label: "Work",
      displayName: "",
      fromAddress: "sender@example.com",
      defaultCc: [],
      defaultBcc: [],
      defaultSignatureTemplateId: null,
      authenticationPolicy: { automation: "disabled" },
      isDefault: false,
    },
  ]);
});

test("identity configuration sends identity-specific defaults without hidden legacy fields", async () => {
  let body: unknown;
  const server = withMailbox(async (request) => {
    const expectedPath = `/api/mail/mailboxes/${MAILBOX_ID}/sender-identities/${IDENTITY_ID}`;
    if (request.method === "PATCH" && new URL(request.url).pathname === expectedPath) {
      body = await request.json();
      return api({
        id: IDENTITY_ID,
        mailboxId: MAILBOX_ID,
        label: "University",
        displayName: "Student representation",
        fromAddress: "sender@example.com",
        replyTo: "replies@example.com",
        defaultCc: [{ address: "archive@example.com" }, { address: "team@example.com" }],
        envelopeSender: null,
        defaultSignatureTemplateId: COMPOSE_TEMPLATE_ID,
        authenticationPolicy: { automation: "mailbox" },
        sentFolderId: null,
        draftsFolderId: null,
        isDefault: false,
        status: "verified",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:01.000Z",
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "identity",
    "configure",
    IDENTITY_ID,
    "--mailbox",
    MAILBOX_ID,
    "--label",
    "University",
    "--name",
    "Student representation",
    "--reply-to",
    "replies@example.com",
    "--default-cc",
    "archive@example.com",
    "--default-cc",
    "team@example.com",
    "--default-signature",
    COMPOSE_TEMPLATE_ID,
  ]);

  expect(result.exitCode).toBe(0);
  expect(body).toEqual({
    label: "University",
    displayName: "Student representation",
    replyTo: "replies@example.com",
    defaultCc: [
      { name: null, address: "archive@example.com" },
      { name: null, address: "team@example.com" },
    ],
    defaultSignatureTemplateId: COMPOSE_TEMPLATE_ID,
  });
});

const workflowSource = `inputs:
  message:
    type: mailMessage
    required: true
steps:
  - addKeyword:
      message: \${{ inputs.message }}
      keyword: Finance
`;

const workflowVersion = {
  id: WORKFLOW_VERSION_ID,
  identity: `${WORKFLOW_ID}:1`,
  workflowId: WORKFLOW_ID,
  mailboxId: MAILBOX_ID,
  source: workflowSource,
  sourceHash: "a".repeat(64),
  boundPlan: { languageId: "mail", languageVersion: 1, manifestHash: "b".repeat(64), inputs: {}, triggers: {}, steps: [] },
  diagnostics: [],
  effectBudget: {
    maxTargets: 1,
    maxMoves: 0,
    maxCopies: 0,
    maxSends: 0,
    maxDrafts: 0,
    maxFlagChanges: 0,
    maxNotifications: 0,
    maxKeywordChanges: 1,
    maxCollaborationChanges: 0,
    maxAiCalls: 0,
  },
  languageId: "mail",
  languageVersion: 1,
  manifestHash: "b".repeat(64),
  createdAt: "2026-07-12T00:00:00.000Z",
};

const workflowDetail = {
  id: WORKFLOW_ID,
  mailboxId: MAILBOX_ID,
  name: "Budgeted workflow",
  description: null,
  priority: 100,
  currentVersionId: WORKFLOW_VERSION_ID,
  activeVersionId: null,
  enabled: false,
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:01.000Z",
  currentVersion: workflowVersion,
  activations: [],
};

test("workflow validate accepts YAML and sends exact canonical source", async () => {
  let requestBody: unknown;
  const server = withMailbox(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === `/api/mail/mailboxes/${MAILBOX_ID}/workflows/validate`) {
      requestBody = await request.json();
      return api({
        valid: true,
        source: (requestBody as { source: string }).source,
        sourceHash: "a".repeat(64),
        ir: null,
        boundPlan: null,
        diagnostics: [],
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(
    `http://127.0.0.1:${server.port}`,
    ["--json", "mail", "workflow", "validate", "--mailbox", MAILBOX_ID, "--source-stdin"],
    workflowSource,
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(requestBody).toEqual({ source: workflowSource });
  expect(JSON.parse(result.stdout)).toMatchObject({ valid: true, sourceHash: "a".repeat(64) });
});

test("workflow create forwards explicit effect budgets", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/workflows`) {
      requestBody = (await request.json()) as Record<string, unknown>;
      return api({
        id: WORKFLOW_ID,
        name: "Budgeted workflow",
        currentVersion: { id: WORKFLOW_VERSION_ID },
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(
    `http://127.0.0.1:${server.port}`,
    [
      "--json",
      "mail",
      "workflow",
      "create",
      "--mailbox",
      MAILBOX_ID,
      "--name",
      "Budgeted workflow",
      "--source-stdin",
      "--max-targets",
      "25",
      "--max-moves",
      "10",
      "--max-keyword-changes",
      "20",
      "--max-collaboration-changes",
      "15",
      "--max-ai-calls",
      "3",
    ],
    workflowSource,
  );

  expect(result.exitCode).toBe(0);
  expect(requestBody as Record<string, unknown> | null).toMatchObject({
    name: "Budgeted workflow",
    source: workflowSource,
    effectBudget: { maxTargets: 25, maxMoves: 10, maxKeywordChanges: 20, maxCollaborationChanges: 15, maxAiCalls: 3 },
  });
});

test("workflow update reads optimistic state before patching metadata", async () => {
  const requests: Array<{ method: string; body: unknown }> = [];
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/workflows/${WORKFLOW_ID}`) {
      if (request.method === "GET") return api(workflowDetail);
      requests.push({ method: request.method, body: await request.json() });
      return api({ ...workflowDetail, name: "Renamed", description: null, priority: 25 });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "workflow",
    "update",
    WORKFLOW_ID,
    "--mailbox",
    MAILBOX_ID,
    "--name",
    "Renamed",
    "--clear-description",
    "--priority",
    "25",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(requests).toEqual([
    {
      method: "PATCH",
      body: {
        expectedUpdatedAt: workflowDetail.updatedAt,
        name: "Renamed",
        description: null,
        priority: 25,
      },
    },
  ]);
});

test("workflow export writes exact YAML bytes and structured versions", async () => {
  const requestedPaths: string[] = [];
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    requestedPaths.push(url.pathname);
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/workflows/${WORKFLOW_ID}`) return api(workflowDetail);
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/workflows/${WORKFLOW_ID}/versions/${WORKFLOW_VERSION_ID}`) {
      return api(workflowVersion);
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  const current = await runCli(origin, ["mail", "workflow", "export", WORKFLOW_ID, "--mailbox", MAILBOX_ID]);
  const historical = await runCli(origin, [
    "--json",
    "mail",
    "workflow",
    "export",
    WORKFLOW_ID,
    "--mailbox",
    MAILBOX_ID,
    "--version-id",
    WORKFLOW_VERSION_ID,
  ]);

  expect(current).toEqual({ exitCode: 0, stdout: workflowSource, stderr: "" });
  expect(historical.exitCode).toBe(0);
  expect(historical.stderr).toBe("");
  expect(JSON.parse(historical.stdout)).toEqual(workflowVersion);
  expect(requestedPaths).toEqual([
    `/api/mail/mailboxes/${MAILBOX_ID}/workflows/${WORKFLOW_ID}`,
    `/api/mail/mailboxes/${MAILBOX_ID}/workflows/${WORKFLOW_ID}/versions/${WORKFLOW_VERSION_ID}`,
  ]);
});

test("workflow version restore forwards the expected current version", async () => {
  let body: unknown;
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/workflows/${WORKFLOW_ID}/versions/${WORKFLOW_VERSION_ID}/restore`
    ) {
      body = await request.json();
      return api({ ...workflowDetail, currentVersion: { ...workflowVersion, id: "00000000-0000-4000-8000-000000000015" } });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "workflow",
    "version",
    "restore",
    WORKFLOW_ID,
    WORKFLOW_VERSION_ID,
    "--mailbox",
    MAILBOX_ID,
    "--current-version-id",
    WORKFLOW_VERSION_ID,
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(body).toEqual({ expectedCurrentVersionId: WORKFLOW_VERSION_ID });
});

test("provider discovery exposes mailbox-scoped autoconfiguration candidates", async () => {
  const candidate = {
    source: "provider_autoconfig",
    email: "support@example.com",
    username: "support@example.com",
    imap: { host: "imap.example.com", port: 993, tlsMode: "implicit" },
    smtp: { host: "smtp.example.com", port: 587, tlsMode: "starttls" },
    authentication: ["password"],
    oauthProviderId: null,
  };
  const requestedEmails: (string | null)[] = [];
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/provider-discovery`) {
      requestedEmails.push(url.searchParams.get("email"));
      return api([candidate]);
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "provider",
    "discover",
    "support@example.com",
    "--mailbox",
    MAILBOX_ID,
  ]);

  expect(result.exitCode).toBe(0);
  expect(requestedEmails).toEqual(["support@example.com"]);
  expect(JSON.parse(result.stdout)).toEqual([candidate]);
});

test("provider list reports managed OAuth state without credentials", async () => {
  const expiresAt = "2026-07-21T12:00:00.000Z";
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/connections`) {
      return api([
        {
          id: CONNECTION_ID,
          mailboxId: MAILBOX_ID,
          name: "Google Mail",
          email: "support@gmail.com",
          username: "support@gmail.com",
          connectorKind: "imap_smtp",
          imap: { host: "imap.gmail.com", port: 993, tlsMode: "implicit" },
          smtp: { host: "smtp.gmail.com", port: 587, tlsMode: "starttls" },
          secret: { kind: "oauth2", isSet: true },
          oauth: { providerId: "google", expiresAt, state: "reconnect_required" },
          status: "degraded",
          authenticatedPrincipal: "support@gmail.com",
          lastVerifiedAt: null,
          lastError: "Authentication failed",
          createdAt: "2026-07-21T10:00:00.000Z",
          updatedAt: "2026-07-21T11:00:00.000Z",
        },
      ]);
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const result = await runCli(`http://127.0.0.1:${server.port}`, ["mail", "provider", "list", "--mailbox", MAILBOX_ID]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("google:reconnect_required");
  expect(result.stdout).toContain(expiresAt);
  expect(result.stdout).not.toContain("accessToken");
  expect(result.stdout).not.toContain("refreshToken");
});

test("provider limit commands expose cached evidence and explicit refresh", async () => {
  const methods: string[] = [];
  const connection = {
    id: CONNECTION_ID,
    mailboxId: MAILBOX_ID,
    name: "Provider",
    email: "sender@example.com",
    status: "active",
    limits: {
      checkedAt: "2026-07-24T12:00:00.000Z",
      imap: {
        status: "supported",
        storage: { used: 1024, limit: 2048 },
        messages: null,
      },
      smtp: { status: "supported", maxMessageBytes: 25_000_000 },
    },
  };
  const server = withMailbox((request) => {
    const url = new URL(request.url);
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/connections/${CONNECTION_ID}/limits/refresh`) {
      methods.push(request.method);
      return api(connection);
    }
    if (request.method === "GET" && url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/connections`) {
      methods.push(request.method);
      return api([connection]);
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);

  const listed = await runCli(`http://127.0.0.1:${server.port}`, ["--json", "mail", "provider", "limits", "--mailbox", MAILBOX_ID]);
  const refreshed = await runCli(`http://127.0.0.1:${server.port}`, [
    "--json",
    "mail",
    "provider",
    "limits",
    "refresh",
    CONNECTION_ID,
    "--mailbox",
    MAILBOX_ID,
  ]);

  expect(listed.exitCode).toBe(0);
  expect(JSON.parse(listed.stdout)).toEqual([connection]);
  expect(refreshed.exitCode).toBe(0);
  expect(JSON.parse(refreshed.stdout)).toEqual(connection);
  expect(methods).toEqual(["GET", "POST"]);
});

test("automatic reply commands cover list, create, and revision-checked update", async () => {
  const input = {
    name: "Out of office",
    enabled: true,
    senderIdentityId: IDENTITY_ID,
    subject: "Re: your message",
    body: "I am away.",
    format: "plain",
    ensureReference: false,
    minimumIntervalHours: 24,
    inactiveBehavior: "skip",
    schedule: {
      mode: "windows",
      timeZone: "UTC",
      activeRanges: [],
      weeklyWindows: [{ weekday: 1, start: "09:00", end: "17:00" }],
      exceptions: [],
    },
  };
  const configuration = {
    id: AUTOMATIC_REPLY_ID,
    mailboxId: MAILBOX_ID,
    workflowId: WORKFLOW_ID,
    workflowVersionId: crypto.randomUUID(),
    ...input,
    revision: 1,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  const requests: Array<{ method: string; body: unknown }> = [];
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/automatic-replies`) {
      if (request.method === "GET") return api([configuration]);
      const body = await request.json();
      requests.push({ method: request.method, body });
      return api({ automaticReply: configuration, referenceConfiguration: null });
    }
    if (url.pathname === `/api/mail/mailboxes/${MAILBOX_ID}/automatic-replies/${AUTOMATIC_REPLY_ID}`) {
      const body = await request.json();
      requests.push({ method: request.method, body });
      return api({ automaticReply: { ...configuration, revision: 2 }, referenceConfiguration: null });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const serverUrl = `http://127.0.0.1:${server.port}`;
  const source = JSON.stringify(input);

  const listed = await runCli(serverUrl, ["--json", "mail", "automatic-reply", "list", "--mailbox", MAILBOX_ID]);
  const created = await runCli(
    serverUrl,
    ["--json", "mail", "automatic-reply", "create", "--mailbox", MAILBOX_ID, "--configuration-stdin"],
    source,
  );
  const updated = await runCli(
    serverUrl,
    [
      "--json",
      "mail",
      "automatic-reply",
      "update",
      AUTOMATIC_REPLY_ID,
      "--mailbox",
      MAILBOX_ID,
      "--revision",
      "1",
      "--configuration-stdin",
    ],
    source,
  );

  expect([listed.exitCode, created.exitCode, updated.exitCode]).toEqual([0, 0, 0]);
  expect(JSON.parse(listed.stdout)).toEqual([configuration]);
  expect(JSON.parse(created.stdout)).toMatchObject({ id: AUTOMATIC_REPLY_ID, revision: 1 });
  expect(JSON.parse(updated.stdout)).toMatchObject({ id: AUTOMATIC_REPLY_ID, revision: 2 });
  expect(requests).toEqual([
    { method: "POST", body: { automaticReply: input } },
    { method: "PATCH", body: { automaticReply: { expectedRevision: 1, ...input } } },
  ]);
});

test("sender commands cover preview and durable existing-message backfills", async () => {
  const operationId = crypto.randomUUID();
  const automation = {
    id: INCOMING_AUTOMATION_ID,
    mailboxId: MAILBOX_ID,
    workflowId: WORKFLOW_ID,
    workflowVersionId: crypto.randomUUID(),
    name: "Example sender",
    enabled: true,
    scope: {
      mode: "matching",
      conditions: { mode: "all", items: [{ field: "sender_address", operator: "is", value: "sender@example.test" }] },
    },
    steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } }],
    latestBackfillOperationId: null,
    workflowSource: "name: Example sender",
    revision: 3,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    const base = `/api/mail/mailboxes/${MAILBOX_ID}/incoming-automations`;
    if (request.method === "GET" && url.pathname === base) return api([automation]);
    if (request.method === "GET" && url.pathname === `${base}/${INCOMING_AUTOMATION_ID}`) return api(automation);
    if (request.method === "POST" && url.pathname === `${base}/preview`) {
      requests.push({ method: request.method, path: url.pathname, body: (await request.json()) as Record<string, unknown> });
      return api({ messageCount: 6, conversationCount: 4 });
    }
    if (request.method === "POST" && url.pathname === `${base}/${INCOMING_AUTOMATION_ID}/backfills`) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({ method: request.method, path: url.pathname, body });
      return api({
        operationId: body.operationId,
        automationId: INCOMING_AUTOMATION_ID,
        workflowVersionId: automation.workflowVersionId,
        state: "queued",
        candidateCount: 6,
        alreadyAcceptedCount: 0,
        newlyAcceptedCount: 0,
        remainingCount: 6,
        failureCount: 0,
        lastError: null,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      });
    }
    if (request.method === "GET" && url.pathname === `${base}/${INCOMING_AUTOMATION_ID}/backfills/${operationId}`) {
      requests.push({ method: request.method, path: url.pathname });
      return api({
        operationId,
        automationId: INCOMING_AUTOMATION_ID,
        workflowVersionId: automation.workflowVersionId,
        state: "running",
        candidateCount: 6,
        alreadyAcceptedCount: 2,
        newlyAcceptedCount: 3,
        remainingCount: 1,
        failureCount: 0,
        lastError: null,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:01.000Z",
      });
    }
    if (request.method === "DELETE" && url.pathname === `${base}/${INCOMING_AUTOMATION_ID}/backfills/${operationId}`) {
      requests.push({ method: request.method, path: url.pathname });
      return api({
        operationId,
        automationId: INCOMING_AUTOMATION_ID,
        workflowVersionId: automation.workflowVersionId,
        state: "canceled",
        candidateCount: 6,
        alreadyAcceptedCount: 2,
        newlyAcceptedCount: 3,
        remainingCount: 1,
        failureCount: 0,
        lastError: null,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:02.000Z",
      });
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  const previewed = await runCli(origin, [
    "--json",
    "mail",
    "sender",
    "preview",
    "--mailbox",
    MAILBOX_ID,
    "--match",
    "sender",
    "--value",
    "sender@example.test",
  ]);
  const started = await runCli(origin, [
    "--json",
    "mail",
    "automation",
    "backfill",
    "start",
    INCOMING_AUTOMATION_ID,
    "--mailbox",
    MAILBOX_ID,
    "--revision",
    "3",
    "--yes",
  ]);
  const startedResult = JSON.parse(started.stdout);
  const status = await runCli(origin, [
    "--json",
    "mail",
    "automation",
    "backfill",
    "status",
    INCOMING_AUTOMATION_ID,
    operationId,
    "--mailbox",
    MAILBOX_ID,
  ]);
  const canceled = await runCli(origin, [
    "--json",
    "mail",
    "automation",
    "backfill",
    "cancel",
    INCOMING_AUTOMATION_ID,
    operationId,
    "--mailbox",
    MAILBOX_ID,
    "--yes",
  ]);

  expect([previewed.exitCode, started.exitCode, status.exitCode, canceled.exitCode]).toEqual([0, 0, 0, 0]);
  expect(JSON.parse(previewed.stdout)).toMatchObject({ messageCount: 6, conversationCount: 4 });
  expect(startedResult).toMatchObject({
    automationId: INCOMING_AUTOMATION_ID,
    state: "queued",
    candidateCount: 6,
  });
  expect(JSON.parse(status.stdout)).toMatchObject({ operationId, state: "running", remainingCount: 1 });
  expect(JSON.parse(canceled.stdout)).toMatchObject({ operationId, state: "canceled" });
  expect(requests).toHaveLength(4);
  expect(requests[0]).toEqual({
    method: "POST",
    path: `/api/mail/mailboxes/${MAILBOX_ID}/incoming-automations/preview`,
    body: {
      scope: {
        mode: "matching",
        conditions: {
          mode: "all",
          items: [{ field: "sender_address", operator: "is", value: "sender@example.test" }],
        },
      },
    },
  });
  expect(requests[1]).toMatchObject({
    method: "POST",
    path: `/api/mail/mailboxes/${MAILBOX_ID}/incoming-automations/${INCOMING_AUTOMATION_ID}/backfills`,
    body: { expectedRevision: 3, operationId: expect.any(String) },
  });
  expect(requests[2]).toEqual({
    method: "GET",
    path: `/api/mail/mailboxes/${MAILBOX_ID}/incoming-automations/${INCOMING_AUTOMATION_ID}/backfills/${operationId}`,
  });
  expect(requests[3]).toEqual({
    method: "DELETE",
    path: `/api/mail/mailboxes/${MAILBOX_ID}/incoming-automations/${INCOMING_AUTOMATION_ID}/backfills/${operationId}`,
  });
}, 20_000);

test("incoming automation CRUD accepts complete mixed-flow definitions and preserves revision fences", async () => {
  const definition = {
    name: "Example sender",
    enabled: true,
    scope: {
      mode: "matching",
      conditions: { mode: "all", items: [{ field: "sender_address", operator: "is", value: "sender@example.test" }] },
    },
    steps: [
      { id: "00000000-0000-4000-8000-000000000040", kind: "mail_action", action: { kind: "mark_read" } },
      {
        id: "00000000-0000-4000-8000-000000000041",
        kind: "ai_generate_text",
        instructions: "Summarize this message",
        maxOutputChars: 2_000,
      },
      {
        id: "00000000-0000-4000-8000-000000000043",
        kind: "create_reply_draft",
        body: { kind: "step_output", sourceStepId: "00000000-0000-4000-8000-000000000041" },
        senderIdentityId: IDENTITY_ID,
      },
    ],
  };
  const automation = {
    id: INCOMING_AUTOMATION_ID,
    mailboxId: MAILBOX_ID,
    workflowId: WORKFLOW_ID,
    workflowVersionId: crypto.randomUUID(),
    name: "Example sender",
    enabled: true,
    scope: definition.scope,
    steps: definition.steps,
    latestBackfillOperationId: null,
    workflowSource: "name: Example sender",
    revision: 3,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
  const mutations: Array<{ method: string; path: string; body: unknown }> = [];
  const server = withMailbox(async (request) => {
    const url = new URL(request.url);
    const base = `/api/mail/mailboxes/${MAILBOX_ID}/incoming-automations`;
    if (request.method === "GET" && url.pathname === `${base}/catalog`) {
      return api({
        folders: [{ id: FOLDER_ID, name: "Inbox", role: "inbox" }],
        assignableUsers: [],
        localTags: [],
      });
    }
    if (request.method === "GET" && url.pathname === base) return api([automation]);
    if (request.method === "GET" && url.pathname === `${base}/${INCOMING_AUTOMATION_ID}`) return api(automation);
    if (url.pathname === base && request.method === "POST") {
      mutations.push({ method: request.method, path: url.pathname, body: await request.json() });
      return api(automation);
    }
    if (url.pathname === `${base}/${INCOMING_AUTOMATION_ID}` && (request.method === "PUT" || request.method === "DELETE")) {
      mutations.push({ method: request.method, path: url.pathname, body: await request.json() });
      return api(request.method === "PUT" ? { ...automation, name: "Updated sender", enabled: false, revision: 4 } : automation);
    }
    return api({ message: "unexpected" }, { status: 500 });
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  const listed = await runCli(origin, ["--jsonl", "mail", "automation", "list", "--mailbox", MAILBOX_ID]);
  const catalog = await runCli(origin, ["--json", "mail", "automation", "catalog", "--mailbox", MAILBOX_ID]);
  const created = await runCli(
    origin,
    ["--json", "mail", "automation", "create", "--mailbox", MAILBOX_ID, "--definition-stdin"],
    JSON.stringify(definition),
  );
  const updatedDefinition = { ...definition, name: "Updated sender", enabled: false };
  const updated = await runCli(
    origin,
    ["--json", "mail", "automation", "update", INCOMING_AUTOMATION_ID, "--mailbox", MAILBOX_ID, "--revision", "3", "--definition-stdin"],
    JSON.stringify(updatedDefinition),
  );
  const stale = await runCli(
    origin,
    ["--json", "mail", "automation", "update", INCOMING_AUTOMATION_ID, "--mailbox", MAILBOX_ID, "--revision", "2", "--definition-stdin"],
    JSON.stringify(definition),
  );
  const missingEnabled = await runCli(
    origin,
    ["--json", "mail", "automation", "update", INCOMING_AUTOMATION_ID, "--mailbox", MAILBOX_ID, "--revision", "3", "--definition-stdin"],
    JSON.stringify({ name: definition.name, scope: definition.scope, steps: definition.steps }),
  );
  const deleted = await runCli(origin, [
    "--json",
    "mail",
    "automation",
    "delete",
    INCOMING_AUTOMATION_ID,
    "--mailbox",
    MAILBOX_ID,
    "--revision",
    "3",
    "--yes",
  ]);

  expect([listed.exitCode, catalog.exitCode, created.exitCode, updated.exitCode, deleted.exitCode]).toEqual([0, 0, 0, 0, 0]);
  expect(JSON.parse(listed.stdout)).toEqual(automation);
  expect(JSON.parse(catalog.stdout)).toMatchObject({ folders: [{ id: FOLDER_ID, name: "Inbox" }] });
  expect(JSON.parse(created.stdout)).toMatchObject({ id: INCOMING_AUTOMATION_ID, revision: 3 });
  expect(JSON.parse(updated.stdout)).toMatchObject({ name: "Updated sender", enabled: false, revision: 4 });
  expect(stale.exitCode).toBe(1);
  expect(stale.stderr).toContain("Incoming automation is at revision 3, not 2");
  expect(missingEnabled.exitCode).toBe(1);
  expect(missingEnabled.stderr).toContain("must explicitly set enabled");
  expect(JSON.parse(deleted.stdout)).toMatchObject({ id: INCOMING_AUTOMATION_ID, revision: 3 });
  expect(mutations).toEqual([
    {
      method: "POST",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/incoming-automations`,
      body: definition,
    },
    {
      method: "PUT",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/incoming-automations/${INCOMING_AUTOMATION_ID}`,
      body: { expectedRevision: 3, ...updatedDefinition },
    },
    {
      method: "DELETE",
      path: `/api/mail/mailboxes/${MAILBOX_ID}/incoming-automations/${INCOMING_AUTOMATION_ID}`,
      body: { expectedRevision: 3 },
    },
  ]);
}, 20_000);
