import { describe, expect, test } from "bun:test";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();

const { default: api } = await import("./api/index");
const { default: pages } = await import("./frontend/index");
const { publicApi } = await import("./public");

describe("compression boundaries", () => {
  for (const path of [
    "/bases/base/editor",
    "/bases/base/editor/__new_route__",
    "/bases/base/shares",
    "/bases/base/shares/__new_route__",
    "/admin/shares",
    "/admin/shares/__new_route__",
  ]) {
    test(`api ${path} opts out`, async () => {
      const response = await api.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
  for (const path of ["/bases", "/bases/base/entries", "/shares", "/admin/entries", "/bases/base/download", "/bases/base/archive"]) {
    test(`api ${path} stays eligible for compression`, async () => {
      const response = await api.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
    });
  }
  for (const path of [
    "/app/filesv2?view=edit&file=outside.docx",
    "/app/filesv2/__new_route__?view=edit&file=outside.docx",
    "/admin/filesv2?view=shares",
    "/admin/filesv2/__new_route__?view=shares",
    "/share/filesv2/s/token",
    "/share/filesv2/inbox/token",
    "/share/filesv2/__new_route__",
  ]) {
    test(`pages ${path} opts out`, async () => {
      const response = await pages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
  for (const path of ["/app/filesv2", "/app/filesv2?view=shares", "/admin/filesv2", "/app/filesv2?view=edit"]) {
    test(`pages ${path} stays eligible for compression`, async () => {
      const response = await pages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
    });
  }
  for (const path of ["/s/token/api", "/inbox/token/api", "/__new_route__"]) {
    test(`public API ${path} opts out`, async () => {
      const response = await publicApi.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
});
