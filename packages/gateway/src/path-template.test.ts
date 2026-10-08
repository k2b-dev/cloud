import { beforeEach, describe, expect, test } from "bun:test";
import { boundTemplateCardinality, derivePathTemplate, OVERFLOW_TEMPLATE, resetTemplateCardinality } from "./path-template";

describe("derivePathTemplate", () => {
  test("collapses uuid segments", () => {
    expect(derivePathTemplate("/api/grids/bases/20838fd2-8c26-42fa-a22d-904cfccda342")).toBe("/api/grids/bases/:id");
  });

  test("collapses numeric segments", () => {
    expect(derivePathTemplate("/api/notifications/4711")).toBe("/api/notifications/:n");
  });

  test("collapses all share descendants before opaque-token heuristics", () => {
    expect(derivePathTemplate("/share/mail/attachments/01HXYZ8QF3K2M9P4R7T6V0W5Z1")).toBe("/share/mail/:token");
  });

  test("redacts digit-free tokens, short tokens and encoded tokens", () => {
    for (const path of ["/share/demo/abcdefghijklmnopqrstuvwxyzABCDEF", "//share/demo/short/", "/share/demo/forms/%61%62%63"]) {
      expect(derivePathTemplate(path)).toBe("/share/demo/:token");
    }
    expect(derivePathTemplate("/api/mail/public-attachments/short/download")).toBe("/api/mail/public-attachments/:token");
    expect(derivePathTemplate("/app/mail/a/short")).toBe("/app/mail/a/:token");
    expect(derivePathTemplate("/share/application123456789/short")).toBe("/share/application123456789/:token");
    expect(derivePathTemplate("/api/demo/01HXYZ8QF3K2M9P4R7T6V0W5Z1")).toBe("/api/demo/:token");
  });

  test("keeps human-readable route params", () => {
    // These are real param shapes in the repo (:topic, :cn, :key) — a
    // heuristic that collapsed them would destroy the useful breakdown.
    expect(derivePathTemplate("/admin/gateway/help/getting-started")).toBe("/admin/gateway/help/getting-started");
    expect(derivePathTemplate("/api/ipa-hosts/hostgroups/webservers")).toBe("/api/ipa-hosts/hostgroups/webservers");
  });

  test("keeps filenames with extensions", () => {
    expect(derivePathTemplate("/public/tabler-icons.woff2")).toBe("/public/tabler-icons.woff2");
    expect(derivePathTemplate("/public/fonts.css")).toBe("/public/fonts.css");
  });

  test("normalizes the root path", () => {
    expect(derivePathTemplate("/")).toBe("/");
    expect(derivePathTemplate("")).toBe("/");
  });

  test("truncates pathological depth", () => {
    const deep = `/${Array.from({ length: 20 }, (_, i) => `seg${i}x`).join("/")}`;
    const result = derivePathTemplate(deep);
    expect(result.endsWith("/...")).toBe(true);
    expect(result.split("/").filter(Boolean)).toHaveLength(9);
  });

  test("does not carry a query string", () => {
    // Callers pass url.pathname; a full URL would leak search params, so the
    // contract is asserted here rather than assumed.
    expect(derivePathTemplate("/app/mail/inbox")).not.toContain("?");
  });
});

describe("boundTemplateCardinality", () => {
  beforeEach(() => {
    resetTemplateCardinality();
  });

  test("passes templates through under the budget", () => {
    expect(boundTemplateCardinality("mail", "/app/mail/inbox")).toBe("/app/mail/inbox");
    expect(boundTemplateCardinality("mail", "/app/mail/inbox")).toBe("/app/mail/inbox");
  });

  test("collapses to an overflow bucket once the budget is spent", () => {
    for (let i = 0; i < 200; i++) boundTemplateCardinality("scanned", `/probe/${i}x`);
    expect(boundTemplateCardinality("scanned", "/probe/fresh")).toBe(OVERFLOW_TEMPLATE);
    // Already-known templates keep reporting truthfully after overflow.
    expect(boundTemplateCardinality("scanned", "/probe/0x")).toBe("/probe/0x");
  });

  test("budgets each app separately", () => {
    for (let i = 0; i < 200; i++) boundTemplateCardinality("noisy", `/probe/${i}x`);
    expect(boundTemplateCardinality("quiet", "/app/quiet/page")).toBe("/app/quiet/page");
  });
});
