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

const { CodeStepBody, CodeStepResult } = await import("./code-steps");
const { isCodeStepResult } = await import("./code-step-words");
const { LocaleProvider } = await import("@k2b/ui");

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
const block = (value: Partial<ToolBlock> & Pick<ToolBlock, "name">): ToolBlock => ({
  id: "tool-1",
  kind: "tool",
  callId: "call-1",
  status: "completed",
  ...value,
});
const render = (component: typeof CodeStepBody | typeof CodeStepResult, value: ToolBlock, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(component, { block: value });
      },
    }),
  );
/** Visible text only: what a person reads. */
const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
/** The patterns of the code-no-source rule: no source, file, line, diagnostic code, ID or hash. */
const technical = [/\bcode\.tsx?\b/i, /\.[a-z]{1,8}:\d+/i, /\bcode_[a-z_]+\b/, /\bsp_[a-z0-9]+\b/i, /\bTS\d{4}\b/, /\b[0-9a-f]{8,}\b/i];
const expectNoCode = (html: string) => {
  for (const pattern of technical) expect(visible(html)).not.toMatch(pattern);
};

const source = Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n");
const words = {
  notices: [
    {
      severity: "block",
      text: "The automation wants to send mail. Code in your Cloud may not do that without a person.",
      consequence: "This version cannot be submitted.",
    },
    { severity: "warning", text: "The page is open to everyone signed in.", consequence: "Everyone in your Cloud can open it." },
  ],
  mayDo: [
    { text: "Create task · Space", isNew: true },
    { text: "Read mail · Mailbox", isNew: false },
  ],
};
const examples = {
  passed: 1,
  total: 2,
  summary: "1 of 2 examples successful",
  explanation: "Successful means the automation met Gustav’s expectation. Cloud does not confirm that the expectation is correct.",
  items: [
    {
      name: "Delivery note with attachment",
      modelLabel: "✦",
      state: "succeeded",
      status: "Successful",
      sentence: "Create task · 1 successful in the example",
      differences: [],
    },
    {
      name: "Delivery note without attachment",
      modelLabel: "✦",
      state: "failed",
      status: "Failed",
      sentence: "Differs from the expectation",
      differences: [{ subject: "Calls", expected: "No calls recorded", actual: "Store file · 1 successful in the example" }],
    },
  ],
};

test("a file Gustav writes shows no source, no file name and no line, live or finished", () => {
  const live = render(
    CodeStepBody,
    block({
      name: "code_write",
      status: "running",
      args: { path: "code.ts", content: source },
      liveArgs: { omittedLines: { path: 0, content: 100 } },
    }),
  );
  const done = render(
    CodeStepBody,
    block({ name: "code_write", args: { codeId: "c_1234", path: "code.tsx", content: source }, result: { version: 1 } }),
  );
  for (const html of [live, done]) {
    expectNoCode(html);
    expect(html).not.toContain("line40");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("k2b-content-code-display");
  }
});

test("a check says what the Code may do in words, with the new rights marked, and never a file or a code", () => {
  const html = render(
    CodeStepBody,
    block({
      name: "code_check",
      result: {
        version: 1,
        result: {
          ok: false,
          diagnostics: [{ code: "code_unresolved_call", message: "Bad code.ts:19 sp_hidden", file: "code.ts", line: 19, column: 1 }],
        },
        manifest: null,
        permissions: [
          {
            operation: "spaces.task.create",
            target: { type: "spaces.space", id: "sp_fixture" },
            title: "Team",
            typeTitle: "Space",
            own: false,
            file: "code.ts",
            line: 4,
            status: "new",
          },
        ],
        words,
      },
    }),
    "en",
  );
  expect(visible(html)).toContain("Create task · Space");
  expect(visible(html)).toContain("new");
  expectNoCode(html);
  expect(html).not.toContain("<details");
});

test("notices stand in the conversation with their consequence; tried examples with their result words", () => {
  const check = block({ name: "code_check", args: { codeId: "c_1234" }, result: { version: 1, result: { ok: true }, words } });
  expect(isCodeStepResult(check)).toBe(true);
  const notices = render(CodeStepResult, check, "de");
  expect(visible(notices)).toContain("Folge: This version cannot be submitted.");
  expect(notices).toContain('data-tone="danger"');
  expect(notices).toContain('data-tone="warning"');
  expectNoCode(notices);

  const test = block({
    name: "code_test",
    args: { codeId: "c_1234" },
    result: { version: 1, mode: "test", ok: false, cases: [], diagnostics: [], words: { notices: [], examples } },
  });
  expect(isCodeStepResult(test)).toBe(true);
  const html = render(CodeStepResult, test, "de");
  const text = visible(html);
  expect(text).toContain("Beispiele");
  expect(text).toContain("1 von 2 erfolgreich");
  expect(text).toContain("Delivery note without attachment");
  expect(text).toContain("Erwartet No calls recorded");
  expect(text).toContain("Passiert Store file · 1 successful in the example");
  expect(html).toContain('data-state="failed"');
  expectNoCode(html);
  // No status word is a bare "OK", "Passt" or "Done".
  expect(text).not.toMatch(/\b(Passt|OK|Gut|Done)\b/);

  const trial = render(CodeStepResult, { ...test, name: "code_simulate" }, "de");
  expect(visible(trial)).toContain("Probelauf");
});

test("a step without words, such as an older result, shows no building block and no raw data", () => {
  const old = block({
    name: "code_test",
    args: { codeId: "c_1234" },
    result: { version: 1, mode: "test", ok: true, cases: [], diagnostics: [] },
  });
  expect(isCodeStepResult(old)).toBe(false);
  const html = render(CodeStepBody, old);
  expectNoCode(html);
  expect(html).not.toContain("<details");
});

test("a failed step names no Core error code; Gustav explains it in the conversation", () => {
  const html = render(
    CodeStepBody,
    block({
      name: "code_submit",
      isError: true,
      result: { version: 1, error: { code: "code_version_conflict", message: "Stale base c_1234.", details: null } },
    }),
    "de",
  );
  expect(visible(html)).toContain("Dieser Schritt hat nicht geklappt.");
  expectNoCode(html);
});
