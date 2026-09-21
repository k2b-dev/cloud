/**
 * Repository check runner.
 *
 *   bun scripts/check.ts                 run every rule
 *   bun scripts/check.ts biome cycles    run selected rules
 *   bun scripts/check.ts --fix           let rules repair what they can
 *   bun scripts/check.ts cycles --apps   rule-specific flags are passed through
 *
 * Rules live in `scripts/checks/<name>.ts` and export `rule: Rule`. A full
 * run checks cycles across every application; a selective run needs `--apps`.
 * Exit code 1 when any rule reports a finding.
 */
import { readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Finding, Rule } from "./checks/rule";
import { workspaceRoot } from "./workspace";

const checksDir = join(import.meta.dir, "checks");
const helpers = new Set(["rule.ts", "files.ts"]);

const loadRules = async (): Promise<Rule[]> => {
  const files = readdirSync(checksDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !helpers.has(name))
    .sort();
  const rules: Rule[] = [];
  for (const file of files) {
    const loaded = (await import(join(checksDir, file))) as { rule?: Rule };
    if (!loaded.rule || loaded.rule.name !== basename(file, ".ts"))
      throw new Error(`scripts/checks/${file} must export a rule named "${basename(file, ".ts")}"`);
    rules.push(loaded.rule);
  }
  return rules;
};

const formatFinding = (finding: Finding): string => {
  const location = finding.file ? `${relative(workspaceRoot, finding.file)}${finding.line ? `:${finding.line}` : ""} ` : "";
  return `  - ${location}${finding.message.split("\n").join("\n    ")}`;
};

const main = async (): Promise<number> => {
  const args = Bun.argv.slice(2);
  const rules = await loadRules();
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const names = args.filter((arg) => !arg.startsWith("--"));

  if (flags.has("--help") || flags.has("-h")) {
    console.log("usage: bun scripts/check.ts [rule...] [--fix] [--apps]\n\nrules:");
    for (const rule of rules) console.log(`  ${rule.name.padEnd(22)} ${rule.description}`);
    return 0;
  }

  const unknown = names.filter((name) => !rules.some((rule) => rule.name === name));
  if (unknown.length > 0) {
    console.error(`unknown rule(s): ${unknown.join(", ")}. Run with --help for the list.`);
    return 2;
  }
  if (names.length === 0) flags.add("--apps");
  const selected = names.length === 0 ? rules : rules.filter((rule) => names.includes(rule.name));
  const ctx = { workspaceRoot, fix: flags.has("--fix"), flags };

  let failed = 0;
  for (const rule of selected) {
    const started = performance.now();
    const findings = await rule.run(ctx);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (findings.length === 0) {
      console.log(`ok    ${rule.name} (${seconds}s)`);
      continue;
    }
    failed += 1;
    console.error(`FAIL  ${rule.name} (${seconds}s): ${findings.length} finding(s)`);
    for (const finding of findings) console.error(formatFinding(finding));
  }

  console.log(`\n${selected.length - failed}/${selected.length} rules passed`);
  return failed > 0 ? 1 : 0;
};

process.exit(await main());
