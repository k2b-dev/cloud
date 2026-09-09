import { expect, test } from "bun:test";

test("audit policy editor bundles for the browser without service dependencies", async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL("./AuditPolicyDialog.tsx", import.meta.url).pathname],
    target: "browser",
    external: ["@k2b/ui", "@k2b/stdlib", "@k2b/stdlib/*", "solid-js", "solid-js/*"],
  });
  expect(bundle.logs.filter((log) => log.level === "error")).toEqual([]);
  expect(bundle.success).toBe(true);
});
