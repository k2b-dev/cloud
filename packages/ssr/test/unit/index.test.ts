import { describe, expect, test } from "bun:test";
import { createConfig } from "../../src/index";

describe("createConfig() cache busting", () => {
  test("uses version 0 without island build output or preloads", async () => {
    const { html } = createConfig({ dev: false, template: ({ scripts }) => scripts });
    const response = await html(() => "content");
    const output = await response.text();
    expect(output).not.toContain("modulepreload");
    expect(output).toContain('<script type="module">const p=');

    expect(output).toBe(
      `<style>solid-client,solid-island{display:contents}</style>\n<script type="module">const p="/_ssr/0";document.querySelectorAll('solid-island,solid-client').forEach(e=>import(p+'/'+e.dataset.id+'.js'));</script>`,
    );
  });

  test("keeps hydration imports unversioned in dev mode", async () => {
    const { html } = createConfig({ dev: true });
    const response = await html(() => "content");
    const output = await response.text();
    expect(output).not.toContain("modulepreload");
    expect(output).toContain('<script type="module">const p=');

    expect(output).toContain('const p="/_ssr"');
    expect(output).not.toContain("?v=");
  });

  test("uses basePath for hydration imports and dev config", async () => {
    const { html } = createConfig({ dev: true, basePath: "/docs" });
    const response = await html(() => "content");
    const output = await response.text();
    expect(output).not.toContain("modulepreload");
    expect(output).toContain('<script type="module">const p=');

    expect(output).toContain('const p="/docs/_ssr"');
    expect(output).toMatch(/globalThis\.__SSR_CONFIG=\{"ssrPath":"\/docs\/_ssr","reloadId":"[0-9a-f-]{36}"\}/);
  });

  test("uses version 0 under normalized basePath without island build output", async () => {
    const { html } = createConfig({ dev: false, basePath: "/docs/" });
    const response = await html(() => "content");
    const output = await response.text();
    expect(output).not.toContain("modulepreload");
    expect(output).toContain('<script type="module">const p=');

    expect(output).toContain('const p="/docs/_ssr/0"');
  });

  test("rejects invalid basePath values", () => {
    expect(() => createConfig({ basePath: "docs" })).toThrow(/basePath must start with "\/" or be empty/);
  });

  test("rejects async render functions", async () => {
    const { html } = createConfig({ dev: false });

    // @ts-expect-error the runtime guard rejects what the type already forbids
    await expect(html(async () => "content")).rejects.toThrow("html() expects a synchronous render function");
  });
});
