import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePackages } from "../workspace";
import type { Finding, Rule } from "./rule";

type DependencySection = Record<string, string>;

type PackageJson = {
  name?: string;
  private?: boolean;
  workspaces?: { packages?: string[]; catalog?: Record<string, string> };
  dependencies?: DependencySection;
  devDependencies?: DependencySection;
  optionalDependencies?: DependencySection;
  peerDependencies?: DependencySection;
  trustedDependencies?: string[];
};

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Dependency policy: the root stays private and hoists nothing, shared
 * versions live in the catalog, private workspaces reference the catalog, and
 * published packages resolve to concrete versions.
 */
export const rule: Rule = {
  name: "dependencies",
  description: "Root catalog, exact versions, and workspace dependency policy",
  run: async ({ workspaceRoot }) => {
    const readPackage = (path: string): PackageJson => JSON.parse(readFileSync(path, "utf8")) as PackageJson;
    const root = readPackage(join(workspaceRoot, "package.json"));
    const catalog = root.workspaces?.catalog ?? {};
    const findings: Finding[] = [];
    const report = (file: string, message: string) => findings.push({ file: join(workspaceRoot, file), message });

    if (root.private !== true) report("package.json", "workspace root must be private");
    if (root.dependencies && Object.keys(root.dependencies).length > 0) {
      report("package.json", "root dependencies must not provide packages to workspaces through hoisting");
    }
    for (const [name, spec] of Object.entries(root.devDependencies ?? {})) {
      if (!exactVersion.test(spec)) report("package.json", `devDependencies.${name} must use an exact version`);
    }
    if (!Array.isArray(root.trustedDependencies) || root.trustedDependencies.length !== 0) {
      report("package.json", "dependency lifecycle scripts must be denied by default");
    }
    for (const [name, version] of Object.entries(catalog)) {
      if (!exactVersion.test(version)) report("package.json", `catalog entry ${name} must use an exact version`);
    }

    for (const workspace of workspacePackages(workspaceRoot)) {
      const file = join(workspace, "package.json");
      const pkg = readPackage(join(workspaceRoot, file));
      const published = pkg.private !== true;

      for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
        for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
          if (spec === "workspace:*") {
            if (published) report(file, `published packages must contain concrete versions for ${section}.${name}`);
            continue;
          }
          if (!published && catalog[name]) {
            if (spec !== "catalog:") report(file, `${section}.${name} must use catalog:`);
            continue;
          }
          if (spec.startsWith("catalog:")) report(file, `published packages must contain concrete versions for ${section}.${name}`);
          else if (!exactVersion.test(spec)) report(file, `${section}.${name} must use an exact version`);
        }
      }

      for (const [name, spec] of Object.entries(pkg.peerDependencies ?? {})) {
        if (spec.startsWith("catalog:")) report(file, `peerDependencies.${name} must be a compatibility range`);
      }
    }

    return findings;
  },
};
