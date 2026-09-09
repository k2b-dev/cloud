import { describe, expect, test } from "bun:test";
import type { CapabilityActionManifest, CapabilityActionReview } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "./frontend/ssr-test-plugin";

const { ActionReviewContent, confirmActionRun } = await import("./action-review");

const action = (overrides: Partial<CapabilityActionManifest> = {}): CapabilityActionManifest => ({
  localId: "contact.delete",
  title: "Delete contact",
  description: "Delete one contact.",
  inputSchema: { type: "object" },
  dataSchema: { type: "object" },
  schemaHash: "a".repeat(64),
  destructive: true,
  openWorld: false,
  idempotency: "none",
  ...overrides,
});

const review: CapabilityActionReview = {
  message: "This contact will be deleted.",
  details: [{ label: "Contact", value: "Ada Lovelace" }],
  links: [{ rel: "open", href: "/app/contacts/ada", title: "Open contact" }],
};

describe("capability action review", () => {
  test("loads and confirms a declared review with the exact action input", async () => {
    const reviewed: unknown[] = [];
    const confirmed: CapabilityActionReview[] = [];
    const decision = await confirmActionRun(
      { appId: "contacts", operation: action({ review: true }), input: { contactId: "ada" } },
      {
        review: async (input) => {
          reviewed.push(input);
          return { ok: true, data: review };
        },
        confirmReview: async (value) => {
          confirmed.push(value);
          return true;
        },
        confirmDestructive: async () => false,
      },
    );

    expect(decision).toEqual({ kind: "approved" });
    expect(reviewed).toEqual([{ appId: "contacts", capabilityId: "contact.delete", input: { contactId: "ada" }, signal: undefined }]);
    expect(confirmed).toEqual([review]);
  });

  test("fails closed when the declared review cannot be loaded", async () => {
    let confirmCalls = 0;
    const decision = await confirmActionRun(
      { appId: "contacts", operation: action({ review: true }), input: { contactId: "ada" } },
      {
        review: async () => ({ ok: false, error: { code: "FORBIDDEN", message: "Review denied", status: 403 } }),
        confirmReview: async () => {
          confirmCalls += 1;
          return true;
        },
        confirmDestructive: async () => true,
      },
    );

    expect(decision).toEqual({ kind: "failed", error: { code: "FORBIDDEN", message: "Review denied", status: 403 } });
    expect(confirmCalls).toBe(0);
  });

  test("keeps the generic confirmation for destructive actions without a review", async () => {
    let reviewCalls = 0;
    const decision = await confirmActionRun(
      { appId: "contacts", operation: action(), input: { contactId: "ada" } },
      {
        review: async () => {
          reviewCalls += 1;
          return { ok: true, data: review };
        },
        confirmReview: async () => true,
        confirmDestructive: async () => false,
      },
    );

    expect(decision).toEqual({ kind: "cancelled" });
    expect(reviewCalls).toBe(0);
  });

  test("renders review consequences, details, and links", () => {
    const html = renderToString(() => createComponent(ActionReviewContent, { review }));

    expect(html).toContain("This contact will be deleted.");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain('href="/app/contacts/ada"');
    expect(html).toContain("Open contact");
  });
});
