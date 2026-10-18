import { describe, expect, test } from "bun:test";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();

const { default: api } = await import("./api/index");
const { default: pages } = await import("./frontend/index");
const { adminPages } = await import("./frontend/index");

describe("compression boundaries", () => {
  for (const path of ["/search"]) {
    test(`api ${path} opts out`, async () => {
      const response = await api.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
  for (const path of [
    "/books",
    "/favorites",
    "/resolve",
    "/books/book/settings-context",
    "/books/book/contacts",
    "/books/book/contacts/contact/notes/page",
    "/books/book/tags",
  ]) {
    test(`api ${path} stays eligible for compression`, async () => {
      const response = await api.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
    });
  }
  for (const path of ["/"]) {
    test(`pages ${path} opts out`, async () => {
      const response = await pages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
  for (const path of ["/book", "/book/e/contact"]) {
    test(`pages ${path} stays eligible for compression`, async () => {
      const response = await pages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
    });
  }
  for (const path of ["/"]) {
    test(`adminPages ${path} stays eligible for compression`, async () => {
      const response = await adminPages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
    });
  }
});
