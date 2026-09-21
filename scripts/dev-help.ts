#!/usr/bin/env bun
/**
 * dev:help — catalog of all dev commands + every app the project ships.
 *
 * Designed to be the first thing an agent (or a new human) runs to get
 * oriented. One call returns:
 *   - every verb, what it does, an example
 *   - every app short-name that can be passed as <app>
 *
 * Output stays plain text — stable section headers ("Stack-level",
 * "Per-app", "Addressable services", "Examples") so a downstream
 * consumer (LLM or grep) has anchors to lock onto.
 */
import { color, listCoreDevServices, listDevServices, shortName } from "./dev-cli";

const services = await listDevServices();
const coreServices = await listCoreDevServices();
const extraCount = services.length - coreServices.length;
const shorts = services.map(shortName);

const lines: string[] = [];
const p = (s = "") => lines.push(s);

p(`${color.bold}Dev commands${color.reset}`);
p("");
p(`${color.bold}Stack-level${color.reset} (infrastructure + compose project)`);
p(`  ${color.cyan}bun run dev${color.reset}                  start infrastructure + core stack (${coreServices.length} app services)`);
p(
  `  ${color.cyan}bun run dev:full${color.reset}             start infrastructure + ${services.length} app services (${extraCount} extras)`,
);
p(`  ${color.cyan}bun run dev:down${color.reset}             remove app stack; keep infrastructure`);
p(`  ${color.cyan}bun run dev:down --infra${color.reset}     remove app stack and stop infrastructure`);
p(`  ${color.cyan}bun run dev:rebuild --all${color.reset}    rebuild all app services`);
p("");
p(`${color.bold}Per-app${color.reset} (one or more apps, space-separated)`);
p(`  ${color.cyan}bun run dev:start <app...>${color.reset}   start app(s) and wait until ready`);
p(`  ${color.cyan}bun run dev:stop <app...>${color.reset}    stop app(s)`);
p(`  ${color.cyan}bun run dev:restart <app...>${color.reset} reload mounted source, no build`);
p(`  ${color.cyan}bun run dev:restart --running${color.reset} reload running app services one at a time`);
p(`  ${color.cyan}bun run dev:rebuild <app...>${color.reset} rebuild + wait until ready`);
p(`  ${color.cyan}bun run dev:logs <app>${color.reset}       follow one app's logs`);
p(`  ${color.cyan}bun run dev:status${color.reset}           list all apps + state`);
p(`  ${color.cyan}bun run dev:status <app>${color.reset}     detail + recent logs for one app`);
p(`  ${color.cyan}bun run dev:help${color.reset}             this catalog`);
p("");
p(`${color.bold}Checkout tools${color.reset}`);
p(`  ${color.cyan}bun run dev:cld -- <args>${color.reset}          run checkout CLI against local Cloud`);
p(`  ${color.cyan}bun run --cwd docs-site dev:docker${color.reset} start isolated documentation (dev:docker:down stops it)`);
p(`  ${color.cyan}bun run --cwd pwas/pwa-auth dev${color.reset}    run the Cloud Login PWA locally`);
p(`  ${color.cyan}bun run check${color.reset}                      all repository checks (bun scripts/check.ts --help lists rules)`);
p(`  ${color.cyan}bun run test${color.reset}                       all test suites (--integration, --filter, --shard)`);
p("");
p(`${color.bold}Addressable services${color.reset} (apps + gateway)`);
// Wrap at ~70 chars for readability without breaking grep-ability.
let row = "  ";
for (const s of shorts) {
  if (row.length + s.length + 1 > 70) {
    p(row);
    row = "  ";
  }
  row += `${s} `;
}
if (row.trim().length > 0) p(row.trimEnd());
p("");
p(`${color.bold}Examples${color.reset}`);
p("  bun run dev:start notebooks");
p("  bun run dev:restart notebooks");
p("  bun run dev:restart --running   # shared packages/cloud source");
p("  bun run dev:rebuild notebooks files grids   # parallel");
p("  bun run dev:logs notebooks");
p("  bun run dev:status notebooks");
p("  bun run dev:cld -- apps list --json");

console.log(lines.join("\n"));
