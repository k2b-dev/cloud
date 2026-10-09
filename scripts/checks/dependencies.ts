import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePackages } from "../workspace";
import type { Finding, Rule } from "./rule";

type DependencySection = Record<string, string>;

type PackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  workspaces?: { packages?: string[]; catalog?: Record<string, string> };
  dependencies?: DependencySection;
  devDependencies?: DependencySection;
  optionalDependencies?: DependencySection;
  peerDependencies?: DependencySection;
  overrides?: DependencySection;
  trustedDependencies?: string[];
};

/** `bun.lock` maps an install path (`hono`, `@k2b/cloud-app-mail/hono`) to `[name@version, ...]`. */
type Lockfile = { packages?: Record<string, [string, ...unknown[]]> };

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Dependency policy: the root stays private and hoists nothing, shared
 * versions live in the catalog, private workspaces reference the catalog, and
 * published packages resolve to concrete versions. A concrete pin of a
 * catalog dependency matches the catalog, so the workspace installs one copy.
 * A peer range on another workspace package accepts that package's version,
 * because release-please bumps pins but leaves peer ranges alone.
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
    // Dependabot does not read Bun catalogs: it bumps concrete pins and leaves the catalog behind.
    const reportCatalogDrift = (file: string, field: string, name: string, spec: string) => {
      if (catalog[name] !== undefined && spec !== catalog[name]) {
        report(file, `${field} is ${spec} but the root catalog has ${name} ${catalog[name]}; set both to one version and run bun install`);
      }
    };

    if (root.private !== true) report("package.json", "workspace root must be private");
    if (root.dependencies && Object.keys(root.dependencies).length > 0) {
      report("package.json", "root dependencies must not provide packages to workspaces through hoisting");
    }
    for (const [name, spec] of Object.entries(root.devDependencies ?? {})) {
      if (!exactVersion.test(spec)) report("package.json", `devDependencies.${name} must use an exact version`);
      reportCatalogDrift("package.json", `devDependencies.${name}`, name, spec);
    }
    for (const [name, spec] of Object.entries(root.overrides ?? {})) reportCatalogDrift("package.json", `overrides.${name}`, name, spec);
    if (!Array.isArray(root.trustedDependencies) || root.trustedDependencies.length !== 0) {
      report("package.json", "dependency lifecycle scripts must be denied by default");
    }
    for (const [name, version] of Object.entries(catalog)) {
      if (!exactVersion.test(version)) report("package.json", `catalog entry ${name} must use an exact version`);
    }

    const workspaces = workspacePackages(workspaceRoot).map((workspace) => {
      const file = join(workspace, "package.json");
      return { file, pkg: readPackage(join(workspaceRoot, file)) };
    });
    const workspaceVersions = new Map(workspaces.flatMap(({ pkg }) => (pkg.name ? [[pkg.name, pkg.version] as const] : [])));
    const workspaceNames = new Set(workspaceVersions.keys());
    for (const { file, pkg } of workspaces) {
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
          else reportCatalogDrift(file, `${section}.${name}`, name, spec);
        }
      }

      for (const [name, spec] of Object.entries(pkg.peerDependencies ?? {})) {
        if (spec.startsWith("catalog:")) report(file, `peerDependencies.${name} must be a compatibility range`);
        const version = workspaceVersions.get(name);
        if (version && !Bun.semver.satisfies(version, spec)) {
          report(file, `peerDependencies.${name} is ${spec} but the workspace has ${name} ${version}; widen the range`);
        }
      }
    }

    // A catalog dependency resolves hoisted or nested directly under a workspace package; every such copy has the catalog version.
    const lock = Bun.JSONC.parse(readFileSync(join(workspaceRoot, "bun.lock"), "utf8")) as Lockfile;
    const resolved = new Map<string, Set<string>>();
    for (const [path, [id]] of Object.entries(lock.packages ?? {})) {
      const at = id.lastIndexOf("@");
      const name = id.slice(0, at);
      const direct = path === name || (path.endsWith(`/${name}`) && workspaceNames.has(path.slice(0, -name.length - 1)));
      if (catalog[name] === undefined || !direct) continue;
      resolved.set(name, (resolved.get(name) ?? new Set()).add(id.slice(at + 1)));
    }
    for (const [name, versions] of resolved) {
      if (versions.size === 1 && versions.has(catalog[name] ?? "")) continue;
      report(
        "bun.lock",
        `workspace packages resolve ${name} to ${[...versions].sort().join(" and ")} but the root catalog has ${catalog[name]}; set the catalog and its concrete pins to one version and run bun install`,
      );
    }

    return findings;
  },
};
