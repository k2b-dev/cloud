import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appIds, devServiceName, imageName } from "../workspace";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const compareSets = (file: string, subject: string, expected: string[], actual: string[], findings: Finding[]) => {
  for (const id of expected) if (!actual.includes(id)) findings.push({ file, message: `${subject} is missing ${id}` });
  for (const id of actual)
    if (!expected.includes(id)) findings.push({ file, message: `${subject} declares ${id}, which is not a workspace application` });
};

/**
 * The application set has one source: `scripts/workspace.ts`. Compose files
 * must declare exactly that set and workflows must derive it instead of
 * carrying hand-written lists.
 */
export const rule: Rule = {
  name: "app-set",
  description: "compose.dev.yml services, compose.prod.yml images, and workflows agree with scripts/workspace.ts",
  run: async ({ workspaceRoot }) => {
    const apps = appIds(workspaceRoot);
    const findings: Finding[] = [];

    const devFile = join(workspaceRoot, "compose.dev.yml");
    const devServices = [...readFileSync(devFile, "utf8").matchAll(/^ {2}(gateway|app-[a-z0-9-]+):/gm)].map((match) => match[1]!);
    compareSets(devFile, "compose.dev.yml", apps.map(devServiceName), devServices, findings);

    const prodFile = join(workspaceRoot, "compose.prod.yml");
    const prodImages = [...readFileSync(prodFile, "utf8").matchAll(/image:\s*ghcr\.io\/k2b-dev\/(cloud-[a-z0-9-]+):/g)].map(
      (match) => match[1]!,
    );
    compareSets(prodFile, "compose.prod.yml", apps.map(imageName), prodImages, findings);

    const handWrittenList = /"accounts","api-docs"|accounts, api-docs|- accounts\n\s+- api-docs/;
    for (const file of listFiles(join(workspaceRoot, ".github", "workflows"), /\.ya?ml$/)) {
      const source = readFileSync(file, "utf8");
      const index = source.search(handWrittenList);
      if (index === -1) continue;
      findings.push({
        file,
        line: source.slice(0, index).split("\n").length,
        message: "hand-written application list; derive it from `bun scripts/workspace.ts apps` or `images`",
      });
    }

    return findings;
  },
};
