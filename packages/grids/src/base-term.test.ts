import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gridsApiMessages } from "./api/messages";
import { capabilityMessagesFor } from "./capability-messages";
import { customAppBuilderMessages } from "./frontend/_components/custom-apps/builder-messages";
import { gridsDialogMessages } from "./frontend/_components/dialogs/messages";
import { documentMessages } from "./frontend/_components/documents/messages";
import { queryMessages } from "./frontend/_components/query/messages";
import { gridsSettingsMessages } from "./frontend/_components/settings/messages";
import { sidebarMessages } from "./frontend/_components/sidebar/messages";
import { workspaceMessages } from "./frontend/_components/workspace/messages";
import { gridsAdminMessages } from "./frontend/admin-messages";
import { gridsMessages } from "./frontend/messages";
import { navigationMessages } from "./navigation-messages";
import { getGridsCrudMessages } from "./service/crud-messages";
import { documentServiceText } from "./service/document-messages";
import { formMessagesFor } from "./service/form-messages";
import { serviceMessagesFor } from "./service/messages";

// Any parameter renders as a number, which every message formats and none contains the term.
const sample = new Proxy({}, { get: () => 2 });

const violations = (text: string) =>
  Array.from(text.matchAll(/\bBases?\b/g))
    .filter((match) => {
      const before = text.slice(0, match.index).replace(/[*_]/g, "");
      return before.trim() !== "" && !/[.!?]\s*$/.test(before);
    })
    .map((match) => text.slice(Math.max(0, match.index - 30), match.index + 40));

describe("Grids base terminology", () => {
  test("English catalogs use base as a sentence-case common noun", () => {
    // Deliberately exclude src/workflows/action-metadata.ts schema descriptions: wording changes alter the manifest hash
    // and cause WORKFLOW_MODULE_MISMATCH for published versions until republished.
    const catalogs: Record<string, Record<string, unknown>> = {
      frontend: gridsMessages.resolve(["en"]).t,
      admin: gridsAdminMessages.resolve(["en"]).t,
      workspace: workspaceMessages.resolve(["en"]).t,
      navigation: navigationMessages.resolve(["en"]).t,
      sidebar: sidebarMessages.resolve(["en"]).t,
      settings: gridsSettingsMessages.resolve(["en"]).t,
      documents: documentMessages.resolve(["en"]).t,
      dialogs: gridsDialogMessages.resolve(["en"]).t,
      query: queryMessages.resolve(["en"]).t,
      builder: customAppBuilderMessages.resolve(["en"]).t,
      api: gridsApiMessages.resolve(["en"]).t,
      capabilities: capabilityMessagesFor("en"),
      service: serviceMessagesFor("en"),
      forms: formMessagesFor("en"),
      documentService: documentServiceText("en"),
      crud: getGridsCrudMessages("en"),
    };
    const problems: string[] = [];
    for (const [catalog, messages] of Object.entries(catalogs)) {
      for (const [key, message] of Object.entries(messages)) {
        const text = String(typeof message === "function" ? message(sample) : message);
        problems.push(...violations(text).map((problem) => `${catalog}.${key}: ${problem}`));
      }
    }
    // The builder's static copy is keyed by English text rather than individual message keys.
    const source = readFileSync(resolve(import.meta.dir, "frontend/_components/custom-apps/builder-messages.ts"), "utf8");
    for (const match of source.slice(0, source.indexOf("} as const;")).matchAll(/^  "([^"\n]+)":/gm)) {
      const value = match[1]!;
      // Check the same text accepted by the builder instead of translating or editing its keys here.
      problems.push(...violations(value).map((problem) => `builder.text: ${problem}`));
    }
    expect(problems).toEqual([]);
  });

  test("English help uses sentence case outside code, heading starts and table-cell starts", () => {
    const paths = [
      "../../../docs-site/apps-content/en/grids.md",
      ...new Glob("{help/documents/en,cli-references,skills}/**/*.md").scanSync(import.meta.dir),
    ];
    const problems: string[] = [];
    for (const path of paths) {
      const markdown = readFileSync(resolve(import.meta.dir, path), "utf8")
        .replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "")
        .replace(/`[^`\n]*`/g, "code");
      for (const paragraph of markdown.split(/\n\s*\n|\n(?=\s*(?:#{1,6}\s|[-*]\s|\d+\.\s))/)) {
        const segments = paragraph.startsWith("|") ? paragraph.split("|") : [paragraph.replace(/^\s*(?:#{1,6}|[-*]|\d+\.)\s+/, "")];
        for (const segment of segments) problems.push(...violations(segment).map((problem) => `${path}: ${problem}`));
      }
    }
    expect(problems).toEqual([]);
  });
});
