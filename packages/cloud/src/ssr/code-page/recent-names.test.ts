import { expect, test } from "bun:test";
import type { CapabilityInvocation } from "../../capabilities/types";
import { capabilityResultSchema } from "../../contracts/capabilities";
import type { CodeActivityReadModel } from "../../contracts/code-read-model";
import type { CodePageInvoke } from "./data";
import { CODE_RECENT_NAME_READS, nameRecentResults, recentResultKey } from "./recent-names";

type Recent = CodeActivityReadModel["recent"][number];
const at = "2026-11-15T09:30:00.000Z";
const row = (id: string, extra: Partial<Recent> = {}): Recent => ({
  text: "Aufgabe angelegt",
  app: "Spaces",
  state: "succeeded",
  at,
  runId: "44444444-4444-4444-8444-444444444444",
  target: { ref: { type: "spaces.item", id }, text: "Aufgabe „{name}“ angelegt" },
  ...extra,
});
const view = (title: string) => ({ view: { title, permission: "read" as const } });
/** Readers answer by item ID: a title with an open link, a refusal, or a failure. `calls` records each invocation. */
const reader = (answers: Record<string, "refused" | "throws" | { title: string; href?: string }>) => {
  const calls: CapabilityInvocation[] = [];
  const invoke: CodePageInvoke = async (invocation, schema) => {
    calls.push(invocation);
    const answer = answers[(invocation.input as { id: string }).id];
    if (!answer || answer === "refused") return { ok: false, error: { code: "FORBIDDEN", message: "Hidden", status: 403 } };
    if (answer === "throws") throw new Error("Reader down");
    return {
      ok: true,
      data: capabilityResultSchema(schema).parse({
        data: view(answer.title),
        ...(answer.href ? { links: [{ rel: "open", href: answer.href }] } : {}),
      }),
    };
  };
  return Object.assign(invoke, { calls });
};

test("a readable target fills the name as plain text and links only to the reader's open link", async () => {
  const invoke = reader({ UxrUVC: { title: "Lieferung $& Weber {name}", href: "/app/spaces/GPzX93/UxrUVC" } });
  const [named] = await nameRecentResults([row("UxrUVC")], invoke, () => "item.read");
  expect(named).toMatchObject({ text: "Aufgabe „Lieferung $& Weber {name}“ angelegt", href: "/app/spaces/GPzX93/UxrUVC" });
  expect(invoke.calls).toEqual([{ appId: "spaces", capabilityId: "item.read", kind: "query", input: { id: "UxrUVC" } }]);
});

test("a reader without right, a failing reader or a type without reader keeps Core's sentence without name, link or ID", async () => {
  const invoke = reader({ hidden: "refused", broken: "throws" });
  const named = await nameRecentResults(
    [row("hidden"), row("broken"), row("noreader", { target: { ref: { type: "other.thing", id: "noreader" }, text: "Ding „{name}“" } })],
    invoke,
    (type) => (type === "spaces.item" ? "item.read" : null),
  );
  for (const item of named) {
    expect(item.text).toBe("Aufgabe angelegt");
    expect(item).not.toHaveProperty("href");
  }
  expect(JSON.stringify(named.map((item) => [item.text, item.href]))).not.toMatch(/hidden|broken|noreader|\{name\}/);
  expect(invoke.calls).toHaveLength(2);
});

test("a title without an open link names the result but adds no link, and an unchecked link is dropped", async () => {
  const [named, plain] = await nameRecentResults(
    [row("UxrUVC", { href: "/unchecked" }), { ...row("x"), target: undefined, href: "/unchecked" }],
    reader({ UxrUVC: { title: "Lieferung" } }),
    () => "item.read",
  );
  expect(named).toMatchObject({ text: "Aufgabe „Lieferung“ angelegt" });
  expect(named).not.toHaveProperty("href");
  expect(plain).not.toHaveProperty("href");
});

test(`at most ${CODE_RECENT_NAME_READS} reads, one per distinct target`, async () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const invoke = reader(Object.fromEntries(ids.map((id) => [id, { title: id.toUpperCase() }])));
  const named = await nameRecentResults([row("a"), row("a"), ...ids.map((id) => row(id))], invoke, () => "item.read");
  expect(invoke.calls).toHaveLength(CODE_RECENT_NAME_READS);
  expect(named.at(-1)?.text).toBe("Aufgabe angelegt");
});

test("a result keeps its key whether or not its name was read", async () => {
  const before = row("UxrUVC");
  const [after] = await nameRecentResults([before], reader({ UxrUVC: { title: "Lieferung" } }), () => "item.read");
  expect(recentResultKey(after!)).toBe(recentResultKey(before));
  expect(recentResultKey(row("other"))).not.toBe(recentResultKey(before));
});
