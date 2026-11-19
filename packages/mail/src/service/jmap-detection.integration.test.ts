import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
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
  let mailboxId = "";
  beforeAll(async () => {
    setSystemTime(new Date("2026-11-19T00:00:00.000Z"));
    const uid = "mail-jmap-detection-fixture";
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, false) RETURNING id
    `;
    if (!user) throw new Error("Fixture user missing");
    userId = user.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: user.id,
          uid,
          provider: "local",
          profile: "user",
          displayName: uid,
          givenName: "Example",
          sn: "Reader",
          mail: "reader@example.invalid",
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId },
      requestId: "mail-jmap-detection-fixture",
    };
    const mailbox = await createMailbox(context, { name: "JMAP detection fixture" });
    if (!mailbox.ok) throw new Error("Fixture mailbox missing");
    mailboxId = mailbox.data.id;
  });
  afterAll(async () => {
    try {
      if (mailboxId) {
        const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
        await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
        for (const row of access) await sql`DELETE FROM auth.access WHERE id = ${row.access_id}::uuid`;
      }
      if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    } finally {
      setSystemTime();
    }
  });

  const stored = async (id: string) => {
    const [row] = await sql<{ jmap_detected: boolean | null; capabilities: Record<string, unknown> }[]>`
      SELECT jmap_detected, capabilities FROM mail.provider_connections WHERE id = ${id}::uuid
    `;
    expect(row).toBeDefined();
    expect(row!.capabilities).not.toHaveProperty("jmap");
    return row!.jmap_detected;
  };

  test("create/replace retain completed observations and preserve unknown only for the same host", async () => {
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(verification);
    const probe = spyOn(jmapClient, "probeJmap").mockImplementation(async () => new Promise<jmapClient.JmapDetection>(() => {}));
    try {
      const created = await createProviderConnection({ context, mailboxId, input });
      if (!created.ok) throw new Error(created.error.message);
      const connectionId = created.data.connection.id;
      expect(await stored(connectionId)).toBeNull();

      probe.mockResolvedValue("detected");
      const positive = await createProviderConnection({
        context,
        mailboxId,
        input: { ...input, name: "Positive fixture", username: "other-reader" },
      });
      if (!positive.ok) throw new Error(positive.error.message);
      expect(await stored(positive.data.connection.id)).toBe(true);

      expect((await replaceProviderConnection({ context, connectionId, input })).ok).toBe(true);
      expect(await stored(connectionId)).toBe(true);
      probe.mockImplementation(async () => new Promise<jmapClient.JmapDetection>(() => {}));
      expect((await replaceProviderConnection({ context, connectionId, input })).ok).toBe(true);
      expect(await stored(connectionId)).toBe(true);
      expect(
        (
          await replaceProviderConnection({
            context,
            connectionId,
            input: { ...input, imap: { ...input.imap, host: "other.example.invalid" } },
          })
        ).ok,
      ).toBe(true);
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
    try {
      const created = await createProviderConnection({ context, mailboxId, input: { ...input, username: "refresh-reader" } });
      if (!created.ok) throw new Error(created.error.message);
      const connectionId = created.data.connection.id;
      expect(await stored(connectionId)).toBe(false);
      const detection = Promise.withResolvers<jmapClient.JmapDetection>();
      probe.mockImplementation(() => detection.promise);
      let finished = false;
      const refresh = refreshProviderConnectionLimits({ context, mailboxId, connectionId }).then((result) => {
        finished = true;
        return result;
      });
      await discovered.promise;
      expect(finished).toBe(false);
      detection.resolve("detected");
      expect((await refresh).ok).toBe(true);
      expect(await stored(connectionId)).toBe(true);
      probe.mockRejectedValue(new Error("Fixture probe failure"));
      expect((await refreshProviderConnectionLimits({ context, mailboxId, connectionId })).ok).toBe(true);
      expect(await stored(connectionId)).toBe(true);
    } finally {
      discover.mockRestore();
      probe.mockRestore();
      verify.mockRestore();
    }
  });
});
