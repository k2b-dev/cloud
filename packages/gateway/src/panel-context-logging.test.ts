import { expect, spyOn, test } from "bun:test";
import * as services from "@k2b/cloud/services";
import { createProxyStats, proxyRequest } from "./proxy";
import { buildRouteTable } from "./trie";

for (const outcome of ["success", "failure"])
  test(`panel ${outcome} telemetry and transport errors exclude the context query`, async () => {
    const url = `http://cloud.test/app/fixture/panel?cloud_panel_context=${encodeURIComponent(JSON.stringify({ scope: { id: "private-place" } }))}`;
    const telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
    const upstream = spyOn(globalThis, "fetch");
    if (outcome === "success") upstream.mockResolvedValue(new Response("ok", { headers: { "X-Route-Template": "/app/fixture/panel" } }));
    else upstream.mockRejectedValue(Object.assign(new Error(`Cannot fetch ${url}`), { path: url, code: "ConnectionRefused" }));
    const entries: unknown[] = [];
    try {
      const response = await proxyRequest(
        new Request(url),
        buildRouteTable([{ prefix: "/app/fixture", appId: "fixture", baseUrl: "http://upstream.test" }]),
        createProxyStats(),
        (message, metadata) => {
          entries.push({ message, metadata });
        },
        null,
        () => {},
      );
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(outcome === "success" ? 200 : 502);
      expect(telemetry).toHaveBeenCalledTimes(1);
      expect(telemetry.mock.calls[0]?.[0].pathTemplate).toBe("/app/fixture/panel");
      for (const serialized of [JSON.stringify(entries), JSON.stringify(telemetry.mock.calls)]) {
        expect(serialized).not.toContain("cloud_panel_context");
        expect(serialized).not.toContain("private-place");
      }
    } finally {
      upstream.mockRestore();
      telemetry.mockRestore();
    }
  });
