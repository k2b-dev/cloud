import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { documentTemplate } from "./document-template";

const root = resolve(import.meta.dir, "../../../..");
const extensions = ["docx", "odp", "ods", "odt", "pptx", "xlsx"];

describe("document templates", () => {
  test("every supported extension has a non-empty template in the source tree", async () => {
    for (const extension of extensions) {
      expect((await documentTemplate(extension)).size, extension).toBeGreaterThan(0);
    }
  });

  test("a missing template is reported as a packaging defect", async () => {
    await expect(documentTemplate("nope")).rejects.toMatchObject({ code: "template_missing", status: 503 });
  });

  test("the production build ships every template next to the bundle", async () => {
    const build = Bun.spawn([process.execPath, "run", "packages/cloud/scripts/build.ts"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production", APP_ID: "filesv2" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, out, err] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
    expect(exit, `${out}\n${err}`).toBe(0);
    expect(await Bun.file(resolve(root, "dist/server.js")).text()).toContain('"./assets/"');
    expect((await readdir(resolve(root, "dist/assets/templates"))).sort()).toEqual(extensions.map((extension) => `empty.${extension}`));
  }, 120_000);
});
