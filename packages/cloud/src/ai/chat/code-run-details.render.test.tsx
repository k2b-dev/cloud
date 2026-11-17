import { expect, test } from "bun:test";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AiTurnBlock } from "../protocol";

const { plugin } = createConfig({ dev: true, rootDir: import.meta.dir });
Bun.plugin(plugin());
const { CodeRunStepBody, isCodeRunStep } = await import("./code-run-step");
const { LocaleProvider } = await import("@k2b/ui");
type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
const source = "export default async () => cloud.spaces.task.create({ title: 'Delivery' })";
const render = (block: ToolBlock, locale: string) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CodeRunStepBody, { block });
      },
    }),
  );

test.each(["de", "en"])("Code run details use words in the request language (%s), without source or raw logs", (locale) => {
  for (const name of ["code_run", "code_inspect"]) {
    expect(isCodeRunStep(name)).toBe(true);
    const block: ToolBlock = {
      id: "tool-run",
      kind: "tool",
      callId: "run",
      name,
      args: { code: source },
      status: "completed",
      result: { status: "ready", output: source, logs: [{ text: source }] },
    };
    const html = render(block, locale);
    expect(html).not.toContain("export default");
    expect(html).toContain(locale === "de" ? "Daten für deine Anfrage verarbeitet" : "processing the data for your request");
    expect(render({ ...block, result: { status: "error", error: source } }, locale)).toContain(
      locale === "de" ? "Dieser Schritt hat nicht geklappt" : "This step did not work",
    );
    expect(render({ ...block, result: { failed: true, error: source } }, locale)).toContain(
      locale === "de" ? "Dieser Schritt hat nicht geklappt" : "This step did not work",
    );
    expect(render({ ...block, result: { status: "ready", work: { status: "running" } } }, locale)).toContain(
      locale === "de" ? "Gustav verarbeitet" : "Gustav is processing",
    );
    expect(render({ ...block, result: { status: "stopped" } }, locale)).toContain(
      locale === "de" ? "Der Lauf wurde gestoppt" : "The run was stopped",
    );
  }
});

test("finished run details name the app's recorded effect in words", () => {
  const html = render(
    {
      id: "tool-run",
      kind: "tool",
      callId: "run",
      name: "code_run",
      status: "completed",
      review: { legacy: { question: "Create delivery task?", rows: [], summary: "Created the delivery task in Spaces." } },
    },
    "en",
  );
  expect(html).toContain("Created the delivery task in Spaces.");
});
