import { describe, expect, test } from "bun:test";
import type { CloudCliContext, CloudCliFlags } from "@k2b/cloud/cli";
import mail from "./cli";
import type { AutomationLogDetail, AutomationLogItem, AutomationLogPage } from "./contracts";

const mailbox = { id: "Mail01", name: "Support", permission: "admin" };
const item: AutomationLogItem = {
  id: "00000000-0000-4000-8000-000000000001",
  at: "2026-10-27T09:00:00.000Z",
  conversation: {
    id: "Convo1",
    subject: "Invoice",
    from: { name: null, email: "customer@example.test" },
    href: "/app/mail/Mail01/conversations/Convo1",
  },
  by: {
    kind: "rule",
    workflowId: "00000000-0000-4000-8000-000000000002",
    name: "Invoices",
    position: 1,
    version: 2,
    ai: true,
    href: "/app/mail/Mail01/automations/workflows",
  },
  outcome: "assigned",
  effects: [{ kind: "assign", target: { kind: "user", id: "user-1", name: "Nora" } }],
  reasons: [{ kind: "ai_choice", value: "Invoice", choices: ["Invoice", "Other"] }],
  undo: { state: "available", reason: null, by: null },
};
const page: AutomationLogPage = {
  day: "2026-10-27",
  counts: { all: 5, assignments: 2, uncertain: 1, skipped: 1, manual: 1 },
  items: [item],
  nextCursor: "opaque+cursor/1",
};
const detail: AutomationLogDetail = {
  ...item,
  chain: [
    { kind: "rule_start", name: "Invoices", version: 2, position: 1, preconditions: ["Nobody was assigned."] },
    { kind: "ai_choice", value: "Invoice", choices: ["Invoice", "Other"] },
    { kind: "ai_value", field: "amount", value: 860, evidence: null },
    { kind: "fixed_row", text: "Invoice → Nora", target: { kind: "user", name: "Nora" } },
    { kind: "result", effects: item.effects, unchanged: ["status"] },
  ],
  aiCalls: { run: 2, today: 5, limit: null },
};

const fixture = (
  args: string[],
  flags: CloudCliFlags = {},
  output: "text" | "json" | "jsonl" = "json",
  handler: (path: string, init?: RequestInit) => Promise<Response> = async () => Response.json(page),
  locale = "en",
) => {
  const values: unknown[] = [];
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const resolved: string[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "https://example.test", token: "fixture", output, locale },
    getDefault: async () => mailbox.id,
    setDefault: async () => undefined,
    createApiClient: () => {
      throw new Error("Unused fixture API client");
    },
    fetch: async (path, init) => {
      if (path.startsWith("/api/mail/resolve")) {
        resolved.push(path);
        return Response.json({ mailbox, folder: null });
      }
      if (path === `/api/mail/mailboxes/${mailbox.id}`) return Response.json(mailbox);
      calls.push({ path, init });
      return handler(path, init);
    },
    readJson: async (response) => {
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    print: (value) => values.push(value),
    write: async (value) => {
      values.push(value);
    },
    error: (value) => values.push(value),
    json: (value) => values.push({ mode: "json", value }),
    jsonLine: (value) => values.push({ mode: "jsonl", value }),
    table: (rows) => values.push(rows),
  };
  return { ctx, values, calls, resolved };
};

describe("Mail automation log CLI", () => {
  test("passes mailbox, day, filter, search, cursor and limit and preserves page counts and links", async () => {
    for (const mode of ["json", "jsonl"] as const) {
      const run = fixture(
        ["automation", "log"],
        { mailbox: "Support", day: "2026-10-27", filter: "assignments", q: "Invoice", before: "opaque/previous+", limit: "1" },
        mode,
      );
      await mail.run(run.ctx);
      expect(run.calls).toHaveLength(1);
      const url = new URL(run.calls[0]!.path, "https://example.test");
      expect(url.pathname).toBe("/api/mail/mailboxes/Mail01/automation-log");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        limit: "1",
        day: "2026-10-27",
        filter: "assignments",
        q: "Invoice",
        before: "opaque/previous+",
      });
      expect(run.values).toEqual([{ mode, value: page }]);
      expect(run.resolved.join(" ")).toContain("Support");
    }
  });

  test("leaves today's date to the server and uses the saved default mailbox", async () => {
    const run = fixture(["automation", "log"]);
    await mail.run(run.ctx);
    expect(run.calls.map((call) => call.path)).toEqual(["/api/mail/mailboxes/Mail01/automation-log?limit=50"]);
  });

  test("text pagination pins the returned day and preserves safely quoted search and filters", async () => {
    const run = fixture(["automation", "log"], { filter: "skipped", q: "customer's $(echo literal)" }, "text");
    await mail.run(run.ctx);
    const output = run.values.join("\n");
    expect(run.values[0]).toEqual([expect.objectContaining({ subject: "Invoice", by: "Invoices", outcome: "assigned" })]);
    expect(output).toContain('"all":5');
    expect(output).toContain("--day '2026-10-27'");
    expect(output).toContain("--before 'opaque+cursor/1'");
    expect(output).toContain("--mailbox 'Mail01'");
    expect(output).toContain("--filter 'skipped'");
    expect(output).toContain("--q 'customer'\\''s $(echo literal)'");
  });

  test("empty text results have a visible state and no next-page hint", async () => {
    const run = fixture(["automation", "log"], {}, "text", async () => Response.json({ ...page, items: [], nextCursor: null }), "de");
    await mail.run(run.ctx);
    expect(run.values.join("\n")).toContain("Keine passenden Protokolleinträge.");
    expect(run.values.join("\n")).not.toContain("Nächste Seite");
  });

  test("show selects the detail path and preserves chain, missing evidence and AI counts", async () => {
    for (const mode of ["json", "jsonl", "text"] as const) {
      const run = fixture(["automation", "log", "show", "opaque/id"], { mailbox: mailbox.id }, mode, async () => Response.json(detail));
      await mail.run(run.ctx);
      expect(run.calls.map((call) => call.path)).toEqual(["/api/mail/mailboxes/Mail01/automation-log/opaque%2Fid"]);
      if (mode === "text") {
        expect(run.values.join("\n")).toContain("Decision chain");
        expect(run.values.join("\n")).toContain('"evidence": null');
        expect(run.values.join("\n")).toContain('AI calls: {"run":2,"today":5,"limit":null}');
      } else expect(run.values).toEqual([{ mode, value: detail }]);
    }
  });

  test("undo sends one bodyless POST and preserves the response envelope", async () => {
    const result = { item: { ...item, undo: { state: "done", reason: null, by: { userId: "user-2", name: "Can" } } } };
    for (const mode of ["json", "jsonl", "text"] as const) {
      const run = fixture(["automation", "log", "undo", item.id], { mailbox: mailbox.id }, mode, async () => Response.json(result), "de");
      await mail.run(run.ctx);
      expect(run.calls).toEqual([{ path: `/api/mail/mailboxes/Mail01/automation-log/${item.id}/undo`, init: { method: "POST" } }]);
      if (mode === "text") expect(run.values.join("\n")).toContain("auch bei späteren Antworten nicht erneut");
      else expect(run.values).toEqual([{ mode, value: result }]);
    }
  });

  test("undo conflict is visible and never emits success or another write", async () => {
    const run = fixture(["automation", "log", "undo", item.id], {}, "text", async () =>
      Response.json({ code: "mail.automation.undo_not_possible", reason: "changed_by_person" }, { status: 409 }),
    );
    await expect(mail.run(run.ctx)).rejects.toThrow("mail.automation.undo_not_possible");
    expect(run.calls).toHaveLength(1);
    expect(run.values).toEqual([]);
  });

  test("rejects invalid calendar dates, filters, bounds and search lengths before log requests", async () => {
    const invalidFlags: CloudCliFlags[] = [
      { day: "2026-02-30" },
      { day: "2026-1-2" },
      { filter: "unknown" },
      { q: "x".repeat(201) },
      { limit: "0" },
      { limit: "51" },
    ];
    for (const flags of invalidFlags) {
      const run = fixture(["automation", "log"], flags);
      await expect(mail.run(run.ctx)).rejects.toThrow();
      expect(run.calls).toEqual([]);
    }
    const accepted = fixture(["automation", "log"], { q: "x".repeat(200), day: "2028-02-29" });
    await mail.run(accepted.ctx);
    expect(accepted.calls).toHaveLength(1);
  });

  test("help localizes the commands and flags without running HTTP", async () => {
    const run = fixture(
      ["automation", "log", "--help"],
      {},
      "text",
      async () => {
        throw new Error("Help must not fetch");
      },
      "de",
    );
    await mail.run(run.ctx);
    expect(run.calls).toEqual([]);
    expect(run.values.join("\n")).toContain("Automatisierungsprotokoll");
    expect(run.values.join("\n")).toContain("--mailbox");
    expect(run.values.join("\n")).toContain("--q");
  });
});
