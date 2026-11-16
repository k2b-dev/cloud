import { capture, type Finding, type Rule } from "./rule";

/** `readResourcePrincipals({ eventPlace: true })` asks a contained place without its container (#3539). */
const ALLOWED = new Set([
  // Defines the option and the exception.
  "packages/cloud/src/capabilities/resource-readers.ts",
  // Code binds an event registration to its place, not to a container.
  "packages/core/src/code/event-access.ts",
]);

export const rule: Rule = {
  name: "event-place-exception",
  description: "Keep the container-free event-place check reserved for Code's event-place check",
  run: async ({ workspaceRoot }) => {
    const { code, output } = await capture(
      [
        "git",
        "grep",
        "--untracked",
        "-n",
        "-w",
        "eventPlace",
        "--",
        "*.ts",
        "*.tsx",
        "*.js",
        "*.mjs",
        "*.cjs",
        ":!*.test.ts",
        ":!*.test.tsx",
        ":!scripts/checks/event-place-exception.ts",
      ],
      { cwd: workspaceRoot },
    );
    if (code === 1 && !output) return [];
    if (code !== 0) return [{ message: `git grep failed: ${output}` }];
    const findings: Finding[] = [];
    for (const line of output.split("\n")) {
      const match = /^([^:]+):(\d+):/.exec(line);
      if (!match || ALLOWED.has(match[1]!)) continue;
      findings.push({
        file: match[1],
        line: Number(match[2]),
        message:
          "`eventPlace` is reserved for Code's event-place check in packages/core/src/code/event-access.ts (#3539). Other callers pass the expected container.",
      });
    }
    return findings;
  },
};
