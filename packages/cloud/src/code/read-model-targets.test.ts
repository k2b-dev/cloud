import { expect, test } from "bun:test";
import { type CodeVersionReadModel, CodeVersionReadModelSchema } from "../contracts/code-read-model";
import { nameCodeGrantTargets } from "./read-model-targets";

const model = (locale = "de"): CodeVersionReadModel => ({
  versionId: "00000000-0000-4000-8000-000000000001",
  number: 1,
  submittedAt: "2026-11-15T08:00:00.000Z",
  locale,
  description: { state: "restricted", text: "Unavailable", modelLabel: "✦" },
  assurance: "Facts",
  mayDo: {
    items: [
      { text: "Postfach lesen · Posteingang", href: "/mail/inbox", app: "Mail" },
      {
        text: "Aufgabe anlegen · Space",
        app: "Spaces",
        target: { ref: { type: "spaces.space", id: "space1" }, text: "Aufgabe anlegen · {name}" },
      },
    ],
    more: 0,
    moreText: null,
  },
  timing: { items: [], more: 0, moreText: null },
  changes: { state: "first", text: "First", rows: { items: [], more: 0, moreText: null }, assurance: "Facts" },
  examples: { state: "none", passed: 0, total: 0, summary: "None", explanation: "Examples", items: [] },
  notices: { items: [], more: 0, moreText: null },
});

test("grant names use an independent canonical reader and only its authorized title and open link", async () => {
  for (const locale of ["de", "en"]) {
    const input = model(locale);
    if (locale === "en") {
      input.mayDo.items[1]!.text = "Create task · Space";
      input.mayDo.items[1]!.target!.text = "Create task · {name}";
    }
    const calls: unknown[] = [];
    const invoke: Parameters<typeof nameCodeGrantTargets>[1] = async (invocation, schema) => {
      calls.push(invocation);
      return {
        ok: true,
        data: {
          data: schema.parse({ view: { title: "Logistics $& {name}", permission: "read" } }),
          links: [
            { rel: "edit", href: "/wrong" },
            { rel: "open", href: "/spaces/readable" },
          ],
        },
      };
    };
    const named = await nameCodeGrantTargets(input, invoke, (type) => (type === "spaces.space" ? "space.read" : null));
    expect(calls).toEqual([{ appId: "spaces", capabilityId: "space.read", kind: "query", input: { id: "space1" } }]);
    expect(named.mayDo.items[1]).toMatchObject({
      text: `${locale === "de" ? "Aufgabe anlegen" : "Create task"} · Logistics $& {name}`,
      href: "/spaces/readable",
    });
    expect(named.mayDo.items[0]).toEqual(input.mayDo.items[0]);
    expect(named.description).toEqual(input.description);
    expect(named.changes).toEqual(input.changes);
    expect(CodeVersionReadModelSchema.parse(named)).toEqual(named);
    expect(input.mayDo.items[1]?.text).not.toContain("Logistics");
  }
});

test("denial, failure, missing readers and malformed slots never create a name or a link", async () => {
  const denied: Parameters<typeof nameCodeGrantTargets>[1] = async () => ({
    ok: false,
    error: { code: "FORBIDDEN", message: "Hidden", status: 403 },
  });
  const failed: Parameters<typeof nameCodeGrantTargets>[1] = async () => {
    throw new Error("Unavailable");
  };
  for (const invoke of [denied, failed]) {
    const input = model();
    input.mayDo.items[1]!.href = "/unchecked";
    const result = await nameCodeGrantTargets(input, invoke, () => "space.read");
    expect(result.mayDo.items[1]).not.toHaveProperty("href");
    expect(result.mayDo.items[1]?.text).toBe("Aufgabe anlegen · Space");
    expect(JSON.stringify(result)).not.toContain("Logistics");
  }
  let calls = 0;
  const forbidden: Parameters<typeof nameCodeGrantTargets>[1] = async () => {
    calls++;
    throw new Error("Must not call");
  };
  await nameCodeGrantTargets(model(), forbidden, () => null);
  const invalid = model();
  invalid.mayDo.items[1]!.target!.text = "{name} {name}";
  await nameCodeGrantTargets(invalid, forbidden, () => "space.read");
  expect(calls).toBe(0);
});

test.each(["de", "en"])("bound chat names come only from the viewer's canonical reader in %s", async (locale) => {
  const input = model(locale);
  const text = locale === "de" ? "In einen Chat schreiben, Gustav antwortet" : "Write to a chat, Gustav answers";
  const note =
    locale === "de" ? "KI · mit deinen Rechten, zählt auf dein Kontingent" : "AI · with your rights, counts toward your allowance";
  input.mayDo.items = [
    {
      text,
      note,
      target: {
        ref: { type: "core.ai.chat", id: "cHt234" },
        text: locale === "de" ? "In den Chat „{name}“ schreiben, Gustav antwortet" : "Write to the chat “{name}”, Gustav answers",
      },
    },
  ];
  for (const owner of [true, false]) {
    const calls: unknown[] = [];
    const invoke: Parameters<typeof nameCodeGrantTargets>[1] = async (invocation, schema) => {
      calls.push(invocation);
      return owner
        ? {
            ok: true,
            data: {
              data: schema.parse({ view: { title: "Private report", permission: "write" } }),
              links: [{ rel: "open", href: "/app/assistant?conversation=cHt234" }],
            },
          }
        : { ok: false, error: { code: "NOT_FOUND", message: "Chat not found", status: 404 } };
    };
    const result = await nameCodeGrantTargets(input, invoke, (type) => (type === "core.ai.chat" ? "ai.chat.read" : null));
    expect(calls).toEqual([{ appId: "core", capabilityId: "ai.chat.read", kind: "query", input: { id: "cHt234" } }]);
    expect(result.mayDo.items[0]?.note).toBe(note);
    if (owner) {
      expect(result.mayDo.items[0]).toMatchObject({
        text:
          locale === "de"
            ? "In den Chat „Private report“ schreiben, Gustav antwortet"
            : "Write to the chat “Private report”, Gustav answers",
        href: "/app/assistant?conversation=cHt234",
      });
    } else {
      expect(result.mayDo.items[0]?.text).toBe(text);
      expect(result.mayDo.items[0]).not.toHaveProperty("href");
      expect(JSON.stringify(result)).not.toContain("Private report");
    }
  }
});

test("grant readers deduplicate exact refs and keep the 50-row bound", async () => {
  const input = model();
  input.mayDo.items = Array.from({ length: 50 }, () => ({ ...input.mayDo.items[1]! }));
  let calls = 0;
  const invoke: Parameters<typeof nameCodeGrantTargets>[1] = async (_invocation, schema) => {
    calls++;
    return { ok: true, data: { data: schema.parse({ view: { title: "Readable", permission: "read" } }) } };
  };
  const result = await nameCodeGrantTargets(input, invoke, () => "space.read");
  expect(calls).toBe(1);
  expect(result.mayDo.items).toHaveLength(50);
  expect(result.mayDo.items.every((row) => row.text === "Aufgabe anlegen · Readable")).toBe(true);
});

test("50 distinct grant targets use at most eight concurrent reader calls", async () => {
  const input = model();
  const template = input.mayDo.items[1]!;
  input.mayDo.items = Array.from({ length: 50 }, (_, index) => ({
    ...template,
    target: { ref: { type: "spaces.space", id: `space${index}` }, text: "Aufgabe anlegen · {name}" },
  }));
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const invoke: Parameters<typeof nameCodeGrantTargets>[1] = async (_invocation, schema) => {
    calls++;
    maximum = Math.max(maximum, ++active);
    await Promise.resolve();
    active--;
    return { ok: true, data: { data: schema.parse({ view: { title: "Readable", permission: "read" } }) } };
  };
  const named = await nameCodeGrantTargets(input, invoke, () => "space.read");
  expect(calls).toBe(50);
  expect(maximum).toBe(8);
  expect(active).toBe(0);
  expect(CodeVersionReadModelSchema.parse(named)).toEqual(named);
});

test("request cancellation stops the current read and prevents further grant-reader batches", async () => {
  const controller = new AbortController();
  const input = model();
  input.mayDo.items = Array.from({ length: 50 }, (_, index) => ({
    text: "Space",
    target: { ref: { type: "spaces.space", id: `space${index}` }, text: "Create task · {name}" },
  }));
  let calls = 0;
  const invoke: Parameters<typeof nameCodeGrantTargets>[1] = async (invocation) => {
    calls++;
    expect(invocation.signal).toBe(controller.signal);
    controller.abort(new Error("Request stopped"));
    throw controller.signal.reason;
  };
  await expect(nameCodeGrantTargets(input, invoke, () => "space.read", controller.signal)).rejects.toThrow("Request stopped");
  expect(calls).toBe(1);
  await expect(nameCodeGrantTargets(input, invoke, () => "space.read", controller.signal)).rejects.toThrow("Request stopped");
  expect(calls).toBe(1);
});
