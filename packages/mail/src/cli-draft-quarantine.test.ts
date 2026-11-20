import { describe, expect, test } from "bun:test";
import type { CloudCliContext, CloudCliFlags } from "@k2b/cloud/cli";
import mail from "./cli";

const mailbox = { id: "Mail01", name: "Evidence", permission: "admin" };
const fixture = (args: string[], flags: CloudCliFlags, handler: (path: string, init?: RequestInit) => Promise<Response>, locale = "en") => {
  const output: unknown[] = [];
  const calls: string[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "https://example.test", token: "fixture", output: "json", locale },
    getDefault: async () => mailbox.id,
    setDefault: async () => undefined,
    createApiClient: () => {
      throw new Error("Unused fixture API client");
    },
    fetch: async (path, init) => {
      if (path.startsWith("/api/mail/resolve")) return Response.json({ mailbox, folder: null });
      if (path === `/api/mail/mailboxes/${mailbox.id}`) return Response.json(mailbox);
      calls.push(`${init?.method ?? "GET"} ${path}`);
      return handler(path, init);
    },
    readJson: async (response) => {
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    print: (value) => output.push(value),
    write: async (value) => {
      output.push(value);
    },
    error: (value) => output.push(value),
    json: (value) => output.push(value),
    jsonLine: (value) => output.push(value),
    table: (rows) => output.push(rows),
  };
  return { ctx, output, calls };
};

describe("Mail quarantine recovery CLI", () => {
  test("inspects the admin endpoint without first opening the blocked draft", async () => {
    const inspection = { revision: 4, generation: "1", historyComplete: false, originalRepairPossible: false };
    const run = fixture(["draft", "recovery", "inspect", "Draft1"], { mailbox: mailbox.id }, async (path) => {
      expect(path).toBe("/api/mail/mailboxes/Mail01/drafts/Draft1/quarantine");
      return Response.json(inspection);
    });
    await mail.run(run.ctx);
    expect(run.calls).toEqual(["GET /api/mail/mailboxes/Mail01/drafts/Draft1/quarantine"]);
    expect(run.output).toEqual([inspection]);
  });
  test("requires confirmation without sending any request", async () => {
    const run = fixture(
      ["draft", "recovery", "repair", "Draft1"],
      {
        mailbox: mailbox.id,
        revision: "4",
        generation: "1",
        "request-id": "bb77fa61-9ad9-4c57-9199-a0500f874977",
      },
      async () => {
        throw new Error("Unexpected request");
      },
      "de",
    );
    await expect(mail.run(run.ctx)).rejects.toThrow("--yes");
    expect(run.calls).toEqual([]);
  });
  test("repairs using the inspected revision, generation and stable request id", async () => {
    const requestId = "bb77fa61-9ad9-4c57-9199-a0500f874977";
    const run = fixture(
      ["draft", "recovery", "repair", "Draft1"],
      {
        mailbox: mailbox.id,
        revision: "4",
        generation: "1",
        "request-id": requestId,
        yes: true,
      },
      async (path, init) => {
        expect(path).toBe("/api/mail/mailboxes/Mail01/drafts/Draft1/quarantine/recover");
        expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 4, generation: "1", requestId });
        return Response.json({ outcome: "recovery_copy", reviewRequired: true, draft: { id: "Copied1" } });
      },
    );
    await mail.run(run.ctx);
    expect(run.calls).toHaveLength(1);
    expect(run.output[0]).toMatchObject({
      outcome: "recovery_copy",
      reviewRequired: true,
      draft: { id: "Copied1", permalink: "https://example.test/open/mail.draft/~Copied1" },
    });
  });
});
