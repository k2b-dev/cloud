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
 * "Per-app", "Apps in this project", "Examples") so a downstream
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
p(`${color.bold}Stack-level${color.reset} (whole compose project)`);
p(`  ${color.cyan}bun run dev${color.reset}                  start infra + core stack (${coreServices.length} app services)`);
p(`  ${color.cyan}bun run dev:full${color.reset}             start infra + ${services.length} app services (${extraCount} extras)`);
p(`  ${color.cyan}bun run dev:down${color.reset}             stop app stack; keep infrastructure`);
p(`  ${color.cyan}bun run dev:rebuild:all${color.reset}      rebuild all app services`);
p("");
p(`${color.bold}Infrastructure${color.reset}`);
p(`  ${color.cyan}bun run dev:infra${color.reset}            start Postgres, Valkey, Geo, Filegate, Gotenberg`);
p(`  ${color.cyan}bun run dev:infra:down${color.reset}       stop development infrastructure`);
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
p(`  ${color.cyan}bun run dev:cld -- <args>${color.reset}   run checkout CLI against local Cloud`);
p(`  ${color.cyan}bun run dev:fibel${color.reset}            start isolated documentation`);
p(`  ${color.cyan}bun run dev:fibel:logs${color.reset}       follow documentation logs`);
p(`  ${color.cyan}bun run dev:fibel:down${color.reset}       stop isolated documentation`);
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
p(`  bun run dev:start notebooks`);
p(`  bun run dev:restart notebooks`);
p(`  bun run dev:restart --running   # shared packages/cloud source`);
p(`  bun run dev:rebuild notebooks files grids   # parallel`);
p(`  bun run dev:logs notebooks`);
p(`  bun run dev:status notebooks`);
p(`  bun run dev:cld -- apps list --json`);

console.log(lines.join("\n"));
