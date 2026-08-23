import { describe, expect, test } from "bun:test";

describe("published App page routes", () => {
  test("keeps SSR anonymous-friendly without a Custom App-specific rate limit", async () => {
    const source = await Bun.file(new URL("../index.ts", import.meta.url)).text();
    const routes = source.slice(source.indexOf("export const customAppRoutes"), source.indexOf("/**\n * Default export"));

    expect(routes).not.toContain("rateLimit(");
    expect(routes.match(/auth\.requireRole\("\*"\)/g)).toHaveLength(2);
    expect(routes).not.toContain('auth.requireRole("authenticated"');
    expect(routes).not.toContain("auth.redirectToLogin");
  });

  test("delegates the published page scroll owner to the App surface", async () => {
    const source = await Bun.file(new URL("./page.tsx", import.meta.url)).text();

    expect(source).toContain("<Layout c={c} fullWidth");
  });

  test("keeps App document downloads public-capable and mutations authenticated", async () => {
    const source = await Bun.file(new URL("../../api/custom-apps.ts", import.meta.url)).text();
    const download = source.indexOf('/documents/:documentId/download"');
    const authenticated = source.indexOf('.use(deps.requireAuthenticated ?? auth.requireRole("authenticated"))');
    const optionalActor = source.indexOf('const loadOptionalActor = deps.loadOptionalActor ?? auth.requireRole("*")');
    const records = source.indexOf('/records"');
    const pageForm = source.indexOf('/:blockId/submit"');
    const sidebarForm = source.indexOf('/sidebar/forms/:actionId/submit"');
    const rowAction = source.indexOf('/row-actions/:actionId"');
    const cardFile = source.indexOf('/files/:token"');
    const scanner = source.indexOf('/:blockId/scanner"');

    expect(download).toBeGreaterThan(0);
    expect(optionalActor).toBeGreaterThan(0);
    expect(source.slice(records, pageForm)).toContain("loadOptionalActor");
    expect(source.slice(pageForm, sidebarForm)).toContain("loadOptionalActor");
    expect(source.slice(sidebarForm, download)).toContain("loadOptionalActor");
    expect(source.slice(download, authenticated)).toContain("loadOptionalActor");
    expect(download).toBeLessThan(authenticated);
    expect(sidebarForm).toBeGreaterThan(0);
    expect(sidebarForm).toBeLessThan(authenticated);
    expect(source).not.toContain('/sidebar/actions/:actionId"');
    expect(rowAction).toBeGreaterThan(authenticated);
    expect(source).not.toContain('/bulk-actions/:actionId"');
    expect(cardFile).toBeLessThan(authenticated);
    expect(scanner).toBeGreaterThan(authenticated);
    expect(source).toContain("executePublishedCustomAppRecords");
    expect(source).toContain("published.response.rows.some((row) => row.recordId === rowId)");
  });

  test("uses only the normal Grids API rate limit for Custom App runtime routes", async () => {
    const [apiSource, routesSource] = await Promise.all([
      Bun.file(new URL("../../api/index.ts", import.meta.url)).text(),
      Bun.file(new URL("../../api/custom-apps.ts", import.meta.url)).text(),
    ]);

    expect(apiSource).toContain(".use(rateLimit())");
    expect(routesSource).not.toContain("rateLimit(");
  });
});
