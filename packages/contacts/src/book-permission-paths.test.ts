import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("Contacts shares one book permission decision (ACC-02)", async () => {
  const root = import.meta.dir;
  const violations: string[] = [];
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(root)) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const source = readFileSync(join(root, file), "utf8");
    const adminStart = file === "api/index.ts" ? source.indexOf("const adminApi = new Hono") : -1;
    const nextTopLevel = adminStart < 0 ? -1 : source.slice(adminStart + 1).search(/^const /m);
    const adminEnd = nextTopLevel < 0 ? source.length : adminStart + 1 + nextTopLevel;
    // Universal search checks entry roles; book grants still govern its results.
    const searchStart = file === "capabilities.ts" ? source.indexOf("const runSearch = async") : -1;
    const nextSearchTopLevel = searchStart < 0 ? -1 : source.slice(searchStart + 1).search(/^const /m);
    const searchEnd = nextSearchTopLevel < 0 ? source.length : searchStart + 1 + nextSearchTopLevel;
    const failureStart = ["api/index.ts", "capabilities.ts"].includes(file) ? source.indexOf("const failAfterBookAccess =") : -1;
    const nextFailureTopLevel = failureStart < 0 ? -1 : source.slice(failureStart + 1).search(/^const /m);
    const failureEnd = nextFailureTopLevel < 0 ? source.length : failureStart + 1 + nextFailureTopLevel;
    const inFailure = (offset: number) => failureStart >= 0 && offset >= failureStart && offset < failureEnd;
    const report = (pattern: RegExp, rule: string, allowed: (offset: number) => boolean = () => false) => {
      for (const match of source.matchAll(pattern)) {
        if (allowed(match.index)) continue;
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(`src/${file}:${line}: ${rule}`);
      }
    };
    report(/contactsService\s*\.\s*book\s*\.\s*authorize\b/g, "Use the checking service operation instead of book.authorize", inFailure);
    report(
      /\b(?:requireBookAccess|requireBookPermissionInternal)\s*\(/g,
      "Transport pre-checks belong only in failAfterBookAccess",
      inFailure,
    );
    if (file !== "service/access.ts") report(/\bhasRole\s*\(/g, "Only service/access.ts may decide administration authority with hasRole");
    if (file !== "service/access.ts") {
      report(
        /\broles\s*\.\s*includes\s*\(\s*["']admin["']\s*\)/g,
        "Only service/access.ts may decide administration authority with roles.includes",
        (offset) => searchStart >= 0 && offset >= searchStart && offset < searchEnd,
      );
    }
    if (file !== "service/access.ts" && file !== "service/index.ts") {
      report(/\bisContactsAdministrator\b/g, "Contacts administration authority belongs only to service/access.ts and service/index.ts");
    }
    report(/bypassAccess/g, "Book grants cannot be bypassed");
    if (file.startsWith("frontend/") || file.startsWith("api/") || file === "capabilities.ts") {
      report(/\{\s*type:\s*["']user["']\s*,\s*userId\b/g, "Use the request accessSubject instead of constructing a user subject");
    }
    if (file !== "frontend/admin.tsx") {
      report(
        /\bbook\s*\.\s*admin\s*\./g,
        "Book administration belongs only to the administration page and /admin API group",
        (offset) => adminStart >= 0 && offset >= adminStart && offset < adminEnd,
      );
    }
  }
  expect(violations, `Authorization copies diverge (ACC-02):\n${violations.join("\n")}`).toEqual([]);
});
