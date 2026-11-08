import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "tools-detail-panel-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { RequestDetail } = await import("./WebhookTester.island.tsx");

const legacyDetailClasses = ['class="detail-header', 'class="detail-stack', 'class="detail-section'];

describe("Tools detail panels", () => {
  test("groups webhook request and response data under one shared scroll owner", () => {
    const log: Parameters<typeof RequestDetail>[0]["log"] = {
      id: "request-1",
      endpointId: "endpoint-1",
      direction: "incoming",
      method: "POST",
      url: "https://cloud.example.test/hooks/endpoint-1",
      path: "/hooks/endpoint-1",
      query: "attempt=1",
      requestHeaders: { "content-type": "application/json" },
      requestBody: '{"hello":"world"}',
      requestContentType: "application/json",
      responseStatus: 202,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"accepted":true}',
      durationMs: 18,
      error: null,
      createdAt: "2026-08-09T10:00:00.000Z",
    };
    const endpoint: NonNullable<Parameters<typeof RequestDetail>[0]["endpoint"]> = {
      id: "endpoint-1",
      token: "token",
      name: "Stripe test",
      urlPath: "/hooks/endpoint-1",
      requestCount: 1,
      lastRequestAt: log.createdAt,
      createdAt: log.createdAt,
    };

    const html = renderToString(() => createComponent(RequestDetail, { log, endpoint, onClose: () => undefined }));

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain("<h2>Stripe test</h2>");
    expect(html).toContain('data-scroll-preserve="webhook-request-detail-request-1"');
    // K1 outline: kind line with the response state, properties, the bodies, then headers under "More about this request".
    const kind = html.slice(html.indexOf('class="k2b-detail-panel__kind"'), html.indexOf("<h2>"));
    expect(kind).toContain("Incoming request");
    expect(kind).toContain("202");
    expect(html).not.toContain('class="k2b-detail-panel__summary"');
    expect(html).not.toContain("k2b-detail-panel__header-icon");
    expect(html).not.toContain("k2b-detail-panel__section-icon");
    expect(html).toContain('data-layout="rows"');
    expect(html).toContain('data-size="sm"');
    const properties = html.indexOf(">Properties<");
    const requestBody = html.indexOf("Request body");
    const responseBody = html.indexOf("Response body");
    const more = html.indexOf("More about this request");
    expect(properties).toBeGreaterThan(-1);
    expect(properties).toBeLessThan(requestBody);
    expect(requestBody).toBeLessThan(responseBody);
    expect(responseBody).toBeLessThan(more);
    expect(html.slice(more)).toContain("Request headers");
    expect(html.slice(more)).toContain("Response headers");
    // Closed header sections name their header keys.
    expect(html.slice(more)).toContain('class="k2b-detail-panel__section-preview k2b-truncate-fade">content-type</span>');
    expect(html.slice(html.indexOf('class="k2b-detail-panel__primary-actions"'))).toContain("<span>Copy JSON</span>");
    expect(html).toContain('aria-label="Close request details"');
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    expect(html.match(/>Raw<\/span>/g)).toHaveLength(4);
    for (const className of legacyDetailClasses) expect(html).not.toContain(className);
  });
});
