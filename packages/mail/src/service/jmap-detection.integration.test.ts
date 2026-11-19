import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import type { Result } from "@k2b/stdlib";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import {
  type ConnectorVerification,
  EMPTY_CONNECTOR_CAPABILITIES,
  type ProviderConnectionInput,
  unavailableProviderLimitSnapshot,
} from "../contracts";
import type { MailRequestContext } from "./auth";
import { imapSmtpConnector } from "./connectors";
import * as jmapClient from "./connectors/jmap-client";
import { createMailbox } from "./mailboxes";
import { createProviderConnection, refreshProviderConnectionLimits, replaceProviderConnection } from "./provider-connections";

const suite = suiteFor("database", "nats", "valkey");

function requireSuccess<T>(stage: string, result: Result<T>): T {
  if (!result.ok) throw new Error(`${stage}: ${result.error.message}`);
  return result.data;
}
const limits = unavailableProviderLimitSnapshot("2026-11-19T00:00:00.000Z");
const verification: ConnectorVerification = {
  authenticatedPrincipal: "reader",
  serverIdentity: {},
  capabilities: EMPTY_CONNECTOR_CAPABILITIES,
  accounts: [],
  limits,
};
const input: ProviderConnectionInput = {
  name: "JMAP detection fixture",
  email: "reader@example.invalid",
  username: "reader",
  secret: { kind: "password", password: "fixture-only" },
  imap: { host: "mail.example.invalid", port: 993, tlsMode: "implicit" },
  smtp: { host: "mail.example.invalid", port: 587, tlsMode: "starttls" },
};

suite("explicit provider actions persist JMAP observations", () => {
  let context: MailRequestContext;
  let userId = "";
  const mailboxIds: string[] = [];
  beforeAll(async () => {
    setSystemTime(new Date("2026-11-19T00:00:00.000Z"));
    const uid = "mail-jmap-detection-fixture";
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, false) RETURNING id
    `;
    if (!user) throw new Error("Fixture user missing");
    userId = user.id;
    const owner: User = {
      id: user.id,
      uid,
      provider: "local",
      profile: "user",
      displayName: "JMAP fixture owner",
      givenname: "Example",
      sn: "Reader",
      mail: "reader@example.invalid",
      roles: ["user"],
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroupIds: [],
      memberofGroup: [],
      manages: [],
      managesGroupIds: [],
    };
    context = {
      actor: { kind: "user", user: owner },
      accessSubject: { type: "user", userId },
      requestId: uid,
    };
  });
  afterAll(async () => {
    try {
      for (const mailboxId of mailboxIds) {
        const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
        await sql`DELETE FROM events.outbox WHERE app_id = 'mail'
          AND ordering_key IN (${mailboxId}, ${`${mailboxId}:assigned`})`;
        await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
        for (const row of access) await sql`DELETE FROM auth.access WHERE id = ${row.access_id}::uuid`;
      }
      if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    } finally {
      setSystemTime();
    }
  });

  // The partial unique index permits one non-revoked connection per mailbox.
  const connected = async (label: string) => {
    const mailbox = requireSuccess(`${label}: create mailbox`, await createMailbox(context, { name: `JMAP ${label}` }));
    mailboxIds.push(mailbox.id);
    const { connection } = requireSuccess(
      `${label}: create connection`,
      await createProviderConnection({
        context,
        mailboxId: mailbox.id,
        input,
      }),
    );
    return { mailboxId: mailbox.id, connectionId: connection.id };
  };

  const stored = async (id: string) => {
    const [row] = await sql<{ jmap_detected: boolean | null; capabilities: Record<string, unknown> }[]>`
      SELECT jmap_detected, capabilities FROM mail.provider_connections WHERE id = ${id}::uuid
    `;
    if (!row) throw new Error("Read stored JMAP observation: connection row missing");
    expect(row.capabilities).not.toHaveProperty("jmap");
    return row.jmap_detected;
  };

  test("create/replace retain completed observations and preserve unknown only for the same host", async () => {
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(verification);
    const probe = spyOn(jmapClient, "probeJmap").mockImplementation(async () => new Promise<jmapClient.JmapDetection>(() => {}));
    try {
      const { connectionId } = await connected("unfinished detection");
      expect(await stored(connectionId)).toBeNull();

      probe.mockResolvedValue("detected");
      const positive = await connected("positive detection");
      expect(await stored(positive.connectionId)).toBe(true);

      requireSuccess("replace with completed detection", await replaceProviderConnection({ context, connectionId, input }));
      expect(await stored(connectionId)).toBe(true);
      probe.mockImplementation(async () => new Promise<jmapClient.JmapDetection>(() => {}));
      requireSuccess("replace with unfinished detection on same host", await replaceProviderConnection({ context, connectionId, input }));
      expect(await stored(connectionId)).toBe(true);
      requireSuccess(
        "replace with unfinished detection on changed host",
        await replaceProviderConnection({
          context,
          connectionId,
          input: { ...input, imap: { ...input.imap, host: "other.example.invalid" } },
        }),
      );
      expect(await stored(connectionId)).toBeNull();
    } finally {
      probe.mockRestore();
      verify.mockRestore();
    }
  });

  test("limit refresh waits for detection and preserves its value on probe failure", async () => {
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(verification);
    const probe = spyOn(jmapClient, "probeJmap").mockResolvedValue("absent");
    const discovered = Promise.withResolvers<void>();
    const discover = spyOn(imapSmtpConnector, "discoverLimits").mockImplementation(async () => {
      discovered.resolve();
      return limits;
    });
    const detection = Promise.withResolvers<jmapClient.JmapDetection>();
    let refresh: ReturnType<typeof refreshProviderConnectionLimits> | undefined;
    try {
      const { mailboxId, connectionId } = await connected("limit refresh");
      expect(await stored(connectionId)).toBe(false);
      probe.mockImplementation(() => detection.promise);
      let finished = false;
      refresh = refreshProviderConnectionLimits({ context, mailboxId, connectionId }).then((result) => {
        finished = true;
        return result;
      });
      const reached = await Promise.race([
        discovered.promise.then(() => "discovery"),
        refresh.then((result) => {
          requireSuccess("limit refresh before discoverLimits", result);
          return "finished";
        }),
      ]);
      expect(reached, "limit refresh must reach discoverLimits before finishing").toBe("discovery");
      expect(finished, "limit refresh must wait for detection").toBe(false);
      detection.resolve("detected");
      requireSuccess("limit refresh with completed detection", await refresh);
      expect(await stored(connectionId)).toBe(true);
      probe.mockRejectedValue(new Error("Fixture probe failure"));
      requireSuccess("limit refresh with failed detection", await refreshProviderConnectionLimits({ context, mailboxId, connectionId }));
      expect(await stored(connectionId)).toBe(true);
    } finally {
      detection.resolve("unknown");
      // Also release the barrier if an assertion failed before the probe was resolved.
      await refresh?.catch(() => {});
      discover.mockRestore();
      probe.mockRestore();
      verify.mockRestore();
    }
  });
});
