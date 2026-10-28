import { expect, test } from "bun:test";

// SSR rendering in an isolated child process; no browser or server.
test("public island SSR is neutral and accepts only serializable configuration", async () => {
  const source = new URL("../src/Counter.island.tsx", import.meta.url).pathname;
  const staff = new URL("../src/Staff.tsx", import.meta.url).pathname;
  const script = `
    import { strict as assert } from 'node:assert';
    import { createConfig } from '@k2b/ssr';
    import { createComponent } from 'solid-js';
    import { renderToString } from 'solid-js/web';
    const { plugin } = createConfig({ dev: true, rootDir: ${JSON.stringify(new URL("../", import.meta.url).pathname)} });
    Bun.plugin(plugin());
    const { LocaleProvider } = await import('@k2b/ui');
    const { default: Counter } = await import(${JSON.stringify(source)});
    const html = renderToString(() => createComponent(LocaleProvider, { locale: 'de', get children() { return createComponent(Counter, { publicOrigin: 'https://cloud.example.test' }); } }));
    assert.ok(html.includes('Laden-iPad koppeln'));
    assert.ok(html.includes('QR scannen'));
    assert.ok(!html.includes('Lea Muster'));
    assert.ok(!html.includes('450,00'));
    assert.ok(!html.includes('Ankaufsvertrag'));
    assert.ok(!html.includes('browser-bound-token'));
    const { default: Staff } = await import(${JSON.stringify(staff)});
    const api = { status: async () => { throw new Error('not called during SSR'); }, list: async () => ({ items: [], next: null }), pair: async () => { throw new Error('not called during SSR'); }, revoke: async () => {}, visit: async () => { throw new Error('not called during SSR'); } };
    const staffHtml = renderToString(() => createComponent(LocaleProvider, { locale: 'de', get children() { return createComponent(Staff, { initial: { items: [], next: null }, api }); } }));
    assert.ok(staffHtml.includes('Noch kein Laden-iPad gekoppelt.'));
    assert.ok(staffHtml.includes('Gerätename'));
    console.log('neutral SSR and staff empty state passed');
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: new URL("../../../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exitCode, output: exitCode === 0 ? "" : stdout + stderr }).toEqual({ exitCode: 0, output: "" });
}, 30_000);
