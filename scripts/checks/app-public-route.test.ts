import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./app-public-route";

const findings = async (source: string, file = "packages/demo/src/config.ts") => {
  const root = await mkdtemp(join(tmpdir(), "cloud-app-public-route-"));
  try {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
    return (await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).map((finding) => ({
      location: `${relative(root, finding.file ?? "")}:${finding.line}`,
      message: finding.message,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports pages without the public prefix that serves their stylesheet", async () => {
  const found = await findings('export const app = defineApp({\n  id: "demo",\n  routes: ["/api/demo", "/app/demo", "/admin/demo"],\n});');
  expect(found).toEqual([{ location: "packages/demo/src/config.ts:3", message: expect.stringContaining('"/public/<id>"') }]);
});

test("requires the app's own public prefix, not a sibling or a narrower path", async () => {
  expect(await findings('defineApp({ id: "demo", routes: ["/app/demo", "/public/other"] });')).toHaveLength(1);
  expect(await findings('defineApp({ id: "demo", routes: ["/app/demo", "/public/demo/images"] });')).toHaveLength(1);
  expect(await findings('defineApp({ id: DEMO_ID, routes: ["/app/demo", "/public/demo/images"] });')).toHaveLength(1);
  expect(await findings('defineApp({ id: DEMO_ID, routes: ["/app/demo", "/public/demo"] });')).toEqual([]);
});

test("accepts apps with the public prefix and API-only apps", async () => {
  expect(await findings('defineApp({ id: "demo", routes: ["/api/demo", "/app/demo", "/public/demo"] });')).toEqual([]);
  expect(await findings('defineApp({ id: "api", routes: ["/api/api"] });')).toEqual([]);
  expect(await findings('defineApp({ id: "demo", routes: ["/app/demo"] });', "packages/demo/src/page.browser-harness.tsx")).toEqual([]);
});
