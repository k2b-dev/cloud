import { expect, test } from "bun:test";
import { settingsDocumentation, settingsDocumentationHref } from "./documentation";

test("documentation links preserve mirror prefixes and use the published English locale", () => {
  expect(settingsDocumentationHref("http://localhost:4187/", "linux")).toBe("http://localhost:4187/en/docs/operations/linux-identities");
  expect(settingsDocumentationHref("https://docs.example.org/cloud/", "user.appApproval")).toBe(
    "https://docs.example.org/cloud/en/docs/accounts/app-sign-in",
  );
  expect(settingsDocumentationHref("https://cloud.k2b.dev", "user.expiry")).toEndWith("/en/docs/accounts/lifecycle#account-expiry");
});

test("unsafe or unavailable configuration never creates an external link", () => {
  for (const base of [
    undefined,
    "",
    "/docs",
    "javascript:alert(1)",
    "https://user:pass@example.org",
    "https://example.org?a=b",
    "https://example.org#part",
  ]) {
    expect(settingsDocumentationHref(base, "linux")).toBeUndefined();
  }
  expect(settingsDocumentationHref("https://cloud.k2b.dev", "unknown")).toBeUndefined();
});

test("every settings article and heading exists in the canonical documentation", async () => {
  const docs = new URL("../../../../../../docs-site/docs/en/", import.meta.url);
  for (const target of Object.values(settingsDocumentation)) {
    const [path, anchor] = target.split("#");
    const source = await Bun.file(new URL(`${path}.md`, docs)).text();
    if (anchor) {
      const anchors = [...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, heading]) =>
        heading!
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-"),
      );
      expect(anchors).toContain(anchor);
    }
  }
});
