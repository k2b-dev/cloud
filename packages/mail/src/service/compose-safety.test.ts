import { describe, expect, test } from "bun:test";
import type { ComposeSafetySource } from "./compose-safety";
import { evaluateComposeSafety } from "./compose-safety";

const source = (overrides: Partial<ComposeSafetySource> = {}): ComposeSafetySource => ({
  draftId: "00000000-0000-4000-8000-000000000001",
  revision: 3,
  intent: "new",
  to: [{ address: "alex@example.org" }],
  cc: [],
  bcc: [],
  body: "Hello",
  format: "markdown",
  attachmentNames: [],
  config: { internalDomains: ["example.org"], largeRecipientThreshold: 20 },
  ...overrides,
});

describe("compose safety", () => {
  test("warns when attachment language has no attachment", () => {
    expect(evaluateComposeSafety(source({ body: "I attached the report." })).warnings.map((warning) => warning.id)).toContain(
      "missing_attachment",
    );
    expect(evaluateComposeSafety(source({ body: "I did not attach the report." })).warnings.map((warning) => warning.id)).not.toContain(
      "missing_attachment",
    );
  });

  test("localizes warnings for regional German locales", () => {
    expect(evaluateComposeSafety(source({ body: "Im Anhang findest du den Bericht." }), "de-CH").warnings[0]).toEqual({
      id: "missing_attachment",
      title: "Kein Anhang hinzugefügt",
      description: "Die E-Mail erwähnt einen Anhang, enthält aber keine Datei.",
    });
  });

  test("deduplicates recipients before applying the threshold", () => {
    const review = evaluateComposeSafety(
      source({
        to: [{ address: "alex@example.org" }],
        cc: [{ address: "ALEX@example.org" }],
        config: { internalDomains: [], largeRecipientThreshold: 2 },
      }),
    );
    expect(review.warnings.map((warning) => warning.id)).not.toContain("large_recipient_set");
  });

  test("normalizes international domains before checking boundaries", () => {
    const review = evaluateComposeSafety(
      source({
        to: [{ address: "alex@bücher.example" }],
        config: { internalDomains: ["xn--bcher-kva.example"], largeRecipientThreshold: 20 },
      }),
    );
    expect(review.warnings.map((warning) => warning.id)).not.toContain("external_recipients");
  });

  test("warns for external recipients and broad reply-all", () => {
    const review = evaluateComposeSafety(
      source({
        intent: "reply_all",
        to: [{ address: "alex@example.org" }, { address: "sam@outside.example" }],
        cc: [{ address: "casey@example.org" }],
      }),
    );
    expect(review.warnings.map((warning) => warning.id)).toEqual(expect.arrayContaining(["external_recipients", "reply_all"]));
  });

  test("warns when visible and destination link hosts differ", () => {
    const review = evaluateComposeSafety(source({ body: "[https://example.org](https://lookalike.example/login)" }));
    expect(review.warnings.map((warning) => warning.id)).toContain("suspicious_link");
    expect(evaluateComposeSafety(source({ body: "[Project](https://example.org/project)" })).warnings).toHaveLength(0);
  });

  test("fingerprint changes with reviewed content and configuration", () => {
    const initial = evaluateComposeSafety(source());
    expect(evaluateComposeSafety(source({ body: "Changed" })).fingerprint).not.toBe(initial.fingerprint);
    expect(evaluateComposeSafety(source({ config: { internalDomains: [], largeRecipientThreshold: 20 } })).fingerprint).not.toBe(
      initial.fingerprint,
    );
  });
});
