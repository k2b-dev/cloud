import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AiTurnBlock } from "../protocol";

const root = mkdtempSync(resolve(tmpdir(), "cloud-code-step-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { CodeStepBody } = await import("./code-steps");
const { LocaleProvider } = await import("@k2b/ui");

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
const step = (block: Partial<ToolBlock> & Pick<ToolBlock, "name">, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CodeStepBody, {
          block: { id: "tool-1", kind: "tool", callId: "call-1", status: "completed", ...block },
          raw: () => "RAW-INPUT-OUTPUT",
        });
      },
    }),
  );
const numbers = (html: string) => [...html.matchAll(/k2b-content-code-display__number"[^>]*>(\d+)</g)].map((match) => Number(match[1]));
const source = Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n");

test("a written file shows its complete source instead of the call's JSON", () => {
  const html = step({ name: "code_write", args: { codeId: "c_1234", path: "code.tsx", content: source }, result: { version: 1 } });
  expect(numbers(html)).toHaveLength(40);
  expect(html).toContain("code.tsx");
  expect(html).not.toContain("c_1234");
});

test("a check lists findings at file and line, and the rights the Code needs", () => {
  const diagnostic = { code: "TS2304", message: "Cannot find name 'mailbox'.", file: "code.ts", line: 3, column: 9 };
  const failed = step(
    { name: "code_check", result: { version: 1, result: { ok: false, diagnostics: [diagnostic] }, manifest: null, permissions: [] } },
    "de",
  );
  expect(failed).toContain("Befunde");
  expect(failed).toContain("Cannot find name 'mailbox'.");
  expect(failed).toContain("code.ts:3 · TS2304");
  const permission = {
    operation: "spaces.task.create",
    target: { type: "spaces.space", id: "sp_fixture" },
    title: "Team",
    typeTitle: "Space",
    own: false,
    file: "code.ts",
    line: 7,
    status: "new",
  };
  const passed = step({
    name: "code_check",
    result: { version: 1, result: { ok: true, diagnostics: [], permissions: [] }, manifest: null, permissions: [permission] },
  });
  expect(passed).toContain("No findings.");
  expect(passed).toContain("spaces.task.create");
  expect(passed).toContain("Space Team");
  expect(passed).toContain("new");
});

test("a test run counts passed cases and names what failed", () => {
  const html = step({
    name: "code_test",
    result: {
      version: 1,
      mode: "test",
      ok: false,
      error: null,
      diagnostics: [],
      cases: [
        { name: "monday", file: "test/monday.json", ok: true, runs: [] },
        {
          name: "empty week",
          file: "test/empty.json",
          ok: false,
          runs: [{ entrypoint: "monday", ok: false, error: "code_assertion_failed", value: null, calls: [], failures: ["$.calls[0]"] }],
        },
      ],
    },
  });
  expect(html).toContain("1 of 2 test cases passed");
  // A simulation's returned value and ordered calls stay reachable behind the exact input and result.
  expect(html).toContain("Exact input and result");
  expect(html).toContain("RAW-INPUT-OUTPUT");
  expect(html).toContain("test/empty.json · monday · code_assertion_failed · $.calls[0]");
});

test("a run that executed but missed its expectations still names what failed; a passing case names nothing", () => {
  const html = step({
    name: "code_simulate",
    result: {
      version: 1,
      mode: "simulate",
      ok: false,
      error: null,
      diagnostics: [],
      cases: [
        {
          name: "wrong value",
          file: null,
          ok: false,
          runs: [{ entrypoint: "monday", ok: true, error: null, value: 1, calls: [], failures: ["value"] }],
        },
        {
          name: "expected refusal",
          file: null,
          ok: true,
          runs: [{ entrypoint: "monday", ok: false, error: "FORBIDDEN", value: null, calls: [], failures: [] }],
        },
      ],
    },
  });
  expect(html).toContain("monday · value");
  expect(html).not.toContain("FORBIDDEN<");
  expect(html).not.toMatch(/expected refusal<\/span><span class="ai-code-step__where"/);
});

test("tests that could not run say so in the reader's language and keep the stable code", () => {
  const result = { version: 1, mode: "test", ok: false, error: "code_test_invalid_fixture", diagnostics: [], cases: [] };
  const german = step({ name: "code_test", result }, "de");
  expect(german).toContain("Die Tests konnten nicht laufen.");
  expect(german).toContain("code_test_invalid_fixture");
  expect(step({ name: "code_test", result })).toContain("The tests could not run.");
});

test("a refused command shows Core's message, not its error body", () => {
  const html = step({
    name: "code_write",
    args: { codeId: "c_1234", path: "code.ts", content: "x" },
    result: { version: 1, error: { code: "NOT_FOUND", message: "No draft of this Code in this chat.", details: null } },
  });
  expect(html).toContain("No draft of this Code in this chat.");
  expect(html).not.toContain("NOT_FOUND");
});

test("a pulled project lists its files with their length", () => {
  const html = step({
    name: "code_pull",
    result: { version: 1, config: {}, files: { "lib/dates.ts": "a\nb\n", "code.ts": source } },
  });
  expect(html).toContain("2 files");
  expect(html.indexOf("code.ts")).toBeLessThan(html.indexOf("lib/dates.ts"));
  expect(html).toContain("40 lines");
  expect(html).toContain("2 lines");
});
