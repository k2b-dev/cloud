import type { CodeCheckedVersionManifest } from "@k2b/cloud/contracts";

export const chatPageManifest: CodeCheckedVersionManifest = {
  version: 1,
  entry: "code.ts",
  policyRows: [],
  permissions: [],
  ai: false,
  hashes: { source: "a".repeat(64), bundle: "b".repeat(64), sdk: "c".repeat(64) },
  entrypoints: ["/archive", "/"].map((path) => ({
    kind: "route",
    entrypoint: `GET:${path}`,
    file: "code.ts",
    line: 1,
    cron: null,
    title: path === "/" ? "Lieferscheine" : "Archiv",
    route: { method: "GET", path, public: false, page: true },
  })),
};
