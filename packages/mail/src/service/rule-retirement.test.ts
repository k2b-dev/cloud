import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const source = join(import.meta.dir, "..");

test("Mail never imports retired executable rule modules", async () => {
  const forbidden =
    /(?:from\s*|import\s*\()\s*["']\.[^"']*(?:\/workflows\/|\/(?:workflow-(?!effect-order-schema)|incoming-automation(?:s|-(?!targets))|automatic-reply|auto-reply|automation-(?:effect-state|log-recording|assignment-state|activity)|command-legacy-effects))[^"']*["']/;
  const violations: string[] = [];
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(source)) {
    if (file === "service/rule-retirement.test.ts") continue;
    const text = await readFile(join(source, file), "utf8");
    if (forbidden.test(text)) violations.push(file);
  }
  expect(violations).toEqual([]);
});

test("Mail lifecycle starts retained services without a rule worker, timer or backfill pump", async () => {
  const entry = await readFile(join(source, "index.ts"), "utf8");
  const services = await readFile(join(source, "service/index.ts"), "utf8");
  expect(entry).toContain("await retireMailRuleBroker()");
  expect(entry).toContain("await applicationAiRuntime.start()");
  expect(entry).toContain("await commandRuntime.start()");
  expect(entry + services).not.toMatch(/workflowRuntime|startIncomingAutomationBackfillRuntime/);
});
