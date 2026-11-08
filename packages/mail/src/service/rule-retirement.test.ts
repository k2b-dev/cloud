import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const source = join(import.meta.dir, "..");

test("No application imports retired executable Mail rule modules", async () => {
  const packages = resolve(source, "../..");
  const forbidden =
    /^(?:workflows(?:\/|\.|$)|service\/(?:workflows(?:\.|$)|workflow-(?!effect-order-schema)|incoming-automation|automatic-reply|auto-reply|automation-(?:effect-state|log-recording|assignment-state|activity)|command-legacy-effects))/;
  const violations: string[] = [];
  const scanned = new Set<string>();
  for await (const file of new Bun.Glob("*/{src,test,tests}/**/*.{ts,tsx}").scan(packages)) {
    scanned.add(file);
    const path = join(packages, file);
    if (path === import.meta.path) continue;
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)\s*["'](\.[^"']+)["']/g)) {
      const target = relative(source, resolve(dirname(path), match[1]!));
      if (forbidden.test(target)) violations.push(`${file}: ${match[1]}`);
    }
  }
  expect(scanned.has("cloud/src/workflows/store/events.integration.test.ts")).toBeTrue();
  expect(scanned.has("spaces/src/capabilities.ts")).toBeTrue();
  expect(scanned.has("mail/src/service/commands.ts")).toBeTrue();
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
