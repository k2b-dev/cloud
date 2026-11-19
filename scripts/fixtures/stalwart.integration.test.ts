import { test } from "bun:test";
import { ok } from "node:assert/strict";
import { requireInfraUrl, suiteFor } from "../../scripts/fixtures/test-infra";

const core = "urn:ietf:params:jmap:core";
const mail = "urn:ietf:params:jmap:mail";
const submission = "urn:ietf:params:jmap:submission";
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

suiteFor("jmap")("Stalwart setup-mode JMAP infrastructure", () => {
  test("authenticates, imports into Inbox, observes changes and destroys only its own message", async () => {
    const target = new URL(requireInfraUrl("jmap"));
    const username = decodeURIComponent(target.username);
    const password = decodeURIComponent(target.password);
    const token = Buffer.from(`${username}:${password}`).toString("base64");
    const authorization = `Basic ${token}`;
    const sessionUrl = new URL("/jmap/session", target.origin);
    const redact = (text: string): string => {
      for (const secret of [token, target.password, password, target.username, username].filter(Boolean)) {
        text = text.replaceAll(secret, "REDACTED");
      }
      return text;
    };
    function check(condition: unknown, stage: string, response: unknown): asserts condition {
      ok(condition, `${stage}: ${redact(JSON.stringify(response) ?? "no response")}`);
    }
    const request = async (stage: string, url: URL, init: RequestInit = {}): Promise<Record<string, unknown>> => {
      check(url.origin === target.origin && !url.username && !url.password, `${stage}: unexpected endpoint`, url.href);
      const headers = new Headers(init.headers);
      headers.set("authorization", authorization);
      let response: Response;
      let body: string;
      try {
        response = await fetch(url, {
          ...init,
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(3_000),
        });
        body = await response.text();
      } catch {
        throw new Error(`${stage}: request failed or exceeded 3 s; no complete server response`);
      }
      check(response.ok, `${stage}: HTTP ${response.status}`, body);
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error(`${stage}: invalid JSON: ${redact(body)}`);
      }
      check(isObject(data), `${stage}: expected JSON object`, data);
      return data;
    };

    const session = await request("Session", sessionUrl);
    const capabilities = session.capabilities;
    check(
      isObject(capabilities) && [core, mail, submission].every((capability) => capability in capabilities),
      "Session capabilities",
      session,
    );
    const primary = session.primaryAccounts;
    check(isObject(primary) && typeof primary[mail] === "string", "Session primary mail account", session);
    const accountId = primary[mail];
    check(typeof accountId === "string", "Session account id", session);
    const accounts = session.accounts;
    check(isObject(accounts), "Session accounts", session);
    const account = accounts[accountId];
    check(isObject(account) && account.isReadOnly === false, "Session writable account", session);
    check(typeof session.apiUrl === "string" && typeof session.uploadUrl === "string", "Session endpoints", session);
    // Setup mode advertises relative URLs; resolve both against the session URL.
    const apiUrl = new URL(session.apiUrl, sessionUrl);
    const uploadUrl = new URL(session.uploadUrl.replace("{accountId}", encodeURIComponent(accountId)), sessionUrl);
    const method = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const reply = await request(name, apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ using: [core, mail], methodCalls: [[name, { accountId, ...args }, "call"]] }),
      });
      const responses = reply.methodResponses;
      check(Array.isArray(responses) && responses.length === 1, `${name}: methodResponses`, reply);
      const result: unknown = responses[0];
      check(Array.isArray(result) && result[0] === name && result[2] === "call" && isObject(result[1]), `${name}: method result`, reply);
      return result[1];
    };

    const mailboxes = await method("Mailbox/get", { properties: ["id", "role"] });
    check(Array.isArray(mailboxes.list), "Mailbox/get list", mailboxes);
    const inbox: unknown = mailboxes.list.find((box: unknown) => isObject(box) && box.role === "inbox");
    check(isObject(inbox) && typeof inbox.id === "string", "Mailbox/get Inbox", mailboxes);
    const before = await method("Email/get", { ids: [], properties: ["id"] });
    check(typeof before.state === "string", "Email/get initial state", before);

    // Only the isolation identifier varies. Message dates are fixed; no wall clock or random fixture data.
    const messageId = `stalwart-fixture-${process.pid}-${process.hrtime.bigint()}@example.invalid`;
    const receivedAt = "2026-01-15T12:00:00Z";
    const source = [
      "From: Sender <sender@example.invalid>",
      "To: Reader <reader@example.invalid>",
      "Date: Thu, 15 Jan 2026 12:00:00 +0000",
      `Message-ID: <${messageId}>`,
      "Subject: Stalwart infrastructure fixture",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Fictional message for the Cloud integration gate.",
      "",
    ].join("\r\n");
    const upload = await request("Upload", uploadUrl, { method: "POST", headers: { "content-type": "message/rfc822" }, body: source });
    check(typeof upload.blobId === "string" && upload.accountId === accountId, "Upload blob", upload);

    let emailId: string | undefined;
    try {
      const imported = await method("Email/import", {
        emails: { fixture: { blobId: upload.blobId, mailboxIds: { [inbox.id]: true }, keywords: {}, receivedAt } },
      });
      const created = imported.created;
      const email = isObject(created) ? created.fixture : undefined;
      if (isObject(email) && typeof email.id === "string") emailId = email.id;
      check(emailId !== undefined, "Email/import created", imported);
      const changes = await method("Email/changes", { sinceState: before.state });
      check(Array.isArray(changes.created) && changes.created.includes(emailId), "Email/changes created", changes);
    } finally {
      // If the import response was lost, find only this run's unique Message-ID.
      let ids = emailId ? [emailId] : [];
      if (!emailId) {
        const query = await method("Email/query", { filter: { header: ["Message-ID", messageId] } });
        check(Array.isArray(query.ids) && query.ids.every((id: unknown) => typeof id === "string"), "Cleanup Email/query ids", query);
        ids = query.ids;
      }
      if (ids.length > 0) {
        const destroyed = await method("Email/set", { destroy: ids });
        const destroyedIds = destroyed.destroyed;
        check(Array.isArray(destroyedIds) && ids.every((id) => destroyedIds.includes(id)), "Cleanup Email/set destroyed", destroyed);
      }
    }
  });
});
