import { describe, expect, test } from "bun:test";
import type { CloudCliContext, CloudCliModule } from "@valentinkolb/cloud/cli";
import accountsCliModule from "@valentinkolb/cloud-app-accounts/cli";
import apiDocsCliModule from "@valentinkolb/cloud-app-api-docs/cli";
import contactsCliModule from "@valentinkolb/cloud-app-contacts/cli";
import faqCliModule from "@valentinkolb/cloud-app-faq/cli";
import gridsCliModule from "@valentinkolb/cloud-app-grids/cli";
import ipaHostsCliModule from "@valentinkolb/cloud-app-ipa-hosts/cli";
import mailCliModule from "@valentinkolb/cloud-app-mail/cli";
import notebooksCliModule from "@valentinkolb/cloud-app-notebooks/cli";
import oauthCliModule from "@valentinkolb/cloud-app-oauth/cli";
import pulseCliModule from "@valentinkolb/cloud-app-pulse/cli";
import spacesCliModule from "@valentinkolb/cloud-app-spaces/cli";
import toolsCliModule from "@valentinkolb/cloud-app-tools/cli";
import venueCliModule from "@valentinkolb/cloud-app-venue/cli";

const appModules = [
  accountsCliModule,
  apiDocsCliModule,
  contactsCliModule,
  faqCliModule,
  gridsCliModule,
  ipaHostsCliModule,
  mailCliModule,
  notebooksCliModule,
  oauthCliModule,
  pulseCliModule,
  spacesCliModule,
  toolsCliModule,
  venueCliModule,
];

const renderHelp = async (module: CloudCliModule, path: string[]): Promise<string[]> => {
  const lines: string[] = [];
  const unavailable = (): never => {
    throw new Error("Help rendering must not access Cloud runtime services.");
  };
  const context: CloudCliContext = {
    args: [...path, "help"],
    flags: {},
    options: { profile: "test", server: "https://cloud.example.test", token: "test", output: "text" },
    getDefault: unavailable,
    setDefault: unavailable,
    createApiClient: unavailable,
    fetch: unavailable,
    readJson: unavailable,
    print: (value = "") => lines.push(value),
    write: unavailable,
    error: unavailable,
    json: unavailable,
    jsonLine: unavailable,
    table: unavailable,
  };

  expect(await module.run(context)).toBe(0);
  return lines.join("\n").split("\n");
};

describe("app CLI help", () => {
  test("describes every visible command group without the generic fallback", async () => {
    for (const module of appModules) {
      const queue: string[][] = [[]];
      const seen = new Set<string>();

      while (queue.length > 0) {
        const path = queue.shift()!;
        const key = path.join(" ");
        if (seen.has(key)) continue;
        seen.add(key);

        const lines = await renderHelp(module, path);
        const commandsStart = lines.indexOf("Commands:");
        if (commandsStart < 0) continue;

        expect(lines[2], `cld ${module.name} ${key}`.trim()).not.toBe("Commands");
        for (let index = commandsStart + 1; index < lines.length && lines[index] !== ""; index += 1) {
          const line = lines[index]!.trim();
          expect(line, `cld ${module.name} ${key}`.trim()).not.toMatch(/\sCommands$/);
          const child = line.split(/\s+/)[0];
          if (child && child !== "(none)") queue.push([...path, child]);
        }
      }
    }
  });
});
