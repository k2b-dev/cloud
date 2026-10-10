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

describe("Mail keep CLI", () => {
  test("keeps several conversations through bodyless PUT requests", async () => {
    const run = fixture(["keep", "Convo1", "Convo2"], { mailbox: mailbox.id }, async (path, init) => {
      expect(init?.body).toBeUndefined();
      return Response.json({
        conversationId: path.split("/").at(-2),
        keptAt: "2026-10-09T10:00:00Z",
        keptBy: { kind: "system", id: null, displayName: "System", avatarHash: null },
      });
    });
    expect(await mail.run(run.ctx)).toBeUndefined();
    expect(run.calls).toEqual([
      "PUT /api/mail/mailboxes/Mail01/conversations/Convo1/keep",
      "PUT /api/mail/mailboxes/Mail01/conversations/Convo2/keep",
    ]);
    expect(run.output[0]).toMatchObject({
      results: [
        { conversationId: "Convo1", status: "ok", keptBy: { displayName: "System" } },
        { conversationId: "Convo2", status: "ok" },
      ],
    });
  });
  test("a conversation that can't be kept does not stop the others, and the batch exits with status 1", async () => {
    const run = fixture(["keep", "Convo1", "Convo2"], { mailbox: mailbox.id }, async (path) =>
      path.includes("Convo1")
        ? Response.json({ code: "NOT_FOUND", message: "Conversation not found" }, { status: 404 })
        : Response.json({
            conversationId: "Convo2",
            keptAt: "2026-10-09T10:00:00Z",
            keptBy: { kind: "system", id: null, displayName: "System", avatarHash: null },
          }),
    );
    expect(await mail.run(run.ctx)).toBe(1);
    expect(run.calls).toHaveLength(2);
    expect(run.output[0]).toMatchObject({
      results: [
        { conversationId: "Convo1", status: "error", error: expect.stringContaining("Conversation not found") },
        { conversationId: "Convo2", status: "ok" },
      ],
    });
  });
  test("release refuses without confirmation and names both consequences in English and German", async () => {
    for (const locale of ["en", "de"]) {
      const run = fixture(
        ["unkeep", "Convo1"],
        {},
        async () => {
          throw new Error("Unconfirmed release reached HTTP");
        },
        locale,
      );
      await expect(mail.run(run.ctx)).rejects.toThrow(locale === "de" ? "kann wieder gelöscht werden" : "can be deleted again");
      expect(run.calls).toHaveLength(0);
    }
  });
  test("release confirms a bodyless DELETE and returns its structured result", async () => {
    const run = fixture(["unkeep", "Convo1"], { yes: true }, async (_path, init) => {
      expect(init?.body).toBeUndefined();
      return Response.json({ conversationId: "Convo1", released: true });
    });
    await mail.run(run.ctx);
    expect(run.calls).toEqual(["DELETE /api/mail/mailboxes/Mail01/conversations/Convo1/keep"]);
    expect(run.output).toEqual([{ conversationId: "Convo1", released: true }]);
  });
  test("the kept list view reaches the conversation query", async () => {
    const run = fixture(["ls", mailbox.id], { view: "kept" }, async (path) => {
      expect(new URL(path, "https://example.test").searchParams.get("view")).toBe("kept");
      return Response.json({ items: [], nextCursor: null });
    });
    await mail.run(run.ctx);
    expect(run.calls).toHaveLength(1);
  });
  test("a refusal reaches the person with the server's message", async () => {
    const run = fixture(["unkeep", "Convo1"], { yes: true }, async () =>
      Response.json({ code: "FORBIDDEN", message: "Only people who manage this mailbox can stop keeping it." }, { status: 403 }),
    );
    await expect(mail.run(run.ctx)).rejects.toThrow("Only people who manage this mailbox can stop keeping it.");
  });
});
