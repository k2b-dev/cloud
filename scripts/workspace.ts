/**
 * Single source of truth for the workspace layout.
 *
 * Every list of applications, images, or packages in this repository is
 * derived from `workspaces.packages` in the root `package.json` through this
 * module. Do not maintain hand-written copies; `bun scripts/check.ts app-set`
 * enforces that Compose files and workflows agree with it.
 *
 *   bun scripts/workspace.ts apps      # application ids, one per line
 *   bun scripts/workspace.ts images    # image names for the release set (JSON)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const workspaceRoot = join(import.meta.dir, "..");

type RootPackage = { workspaces?: { packages?: string[] } };

/** Packages that live under `packages/` but are libraries or tools, not deployable applications. */
const nonApplicationPackages = new Set(["cloud", "ui", "cloud-cli"]);

export const workspacePackages = (root = workspaceRoot): string[] => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as RootPackage;
  return (pkg.workspaces?.packages ?? []).toSorted();
};

/** Every `packages/<id>` workspace id (applications, libraries, and tools), alphabetically. */
export const packageIds = (root = workspaceRoot): string[] =>
  workspacePackages(root)
    .filter((entry) => entry.startsWith("packages/"))
    .map((entry) => entry.slice("packages/".length));

/** Application ids in a stable order: `gateway`, `core`, then the rest alphabetically. */
export const appIds = (root = workspaceRoot): string[] => {
  const ids = packageIds(root).filter((id) => !nonApplicationPackages.has(id));
  const ordered = ["gateway", "core"].filter((id) => ids.includes(id));
  return [...ordered, ...ids.filter((id) => !ordered.includes(id)).toSorted()];
};

/** GHCR image name (without registry and owner) for an application id. */
export const imageName = (appId: string): string => (appId === "gateway" || appId === "core" ? `cloud-${appId}` : `cloud-app-${appId}`);

/** Service name of an application in `compose.dev.yml`. */
export const devServiceName = (appId: string): string => (appId === "gateway" ? "gateway" : `app-${appId}`);

export type ReleaseImage = { image: string; dockerfile: string; appId?: string };

/** Every image of one Cloud release: all applications plus the website and the Cloud Login PWA. */
export const releaseImages = (): ReleaseImage[] => [
  ...appIds().map((appId) => ({ image: imageName(appId), dockerfile: "Dockerfile", appId })),
  { image: "cloud-website", dockerfile: "docs-site/Dockerfile" },
  { image: "cloud-pwa-auth", dockerfile: "pwas/pwa-auth/Dockerfile" },
];

if (import.meta.main) {
  const command = Bun.argv[2];
  if (command === "apps") console.log(appIds().join("\n"));
  else if (command === "images") console.log(JSON.stringify(releaseImages()));
  else {
    console.error("usage: bun scripts/workspace.ts <apps|images>");
    process.exit(2);
  }
}
