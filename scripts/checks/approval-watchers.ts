import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Whether an approval reaches a person outside the page depends on one rule:
 * no signed-in browser tab streams its chat (`aiApprovalUnwatched`). Cloud
 * Login push and the Pending approvals notification both apply it; deciding by
 * where the turn started left chats whose tab closed without either.
 */
const CALL_SITES = ["packages/cloud/src/services/app-approval.ts", "packages/core/src/ai-notifications.ts"];
const STARTED_IN_BROWSER = /run_config\s*->>\s*'signedInSession'/;

export const checkSource = (file: string, source: string, callSite: boolean): Finding[] => {
  if (isTestFile(file)) return [];
  const findings: Finding[] = [];
  const match = STARTED_IN_BROWSER.exec(source);
  if (match)
    findings.push({
      file,
      line: source.slice(0, match.index).split("\n").length,
      message: "Approval notices follow aiApprovalUnwatched(), not where the turn started.",
    });
  if (callSite && !source.includes("aiApprovalUnwatched("))
    findings.push({ file, message: "This approval notice must ask aiApprovalUnwatched() whether a tab shows the approval." });
  return findings;
};

export const rule: Rule = {
  name: "approval-watchers",
  description: "Approval push and notices share the open-tab rule",
  run: async ({ workspaceRoot }) =>
    listFiles(join(workspaceRoot, "packages"), sourceFilePattern).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return checkSource(file, source, CALL_SITES.includes(relative(workspaceRoot, file)));
    }),
};
