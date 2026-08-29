import { describe, expect, test } from "bun:test";
import { renderEmailTemplate, validateEmailTemplateWrite } from "./email-templates";

describe("email templates", () => {
  test("renders allowed Liquid roots", async () => {
    const result = await renderEmailTemplate(
      {
        subject: "Document for {{ workflow.name }}",
        html: "<p>{{ data.link.url }}</p><p>{{ business.legalName }}</p>",
      },
      {
        data: { link: { url: "https://example.test/document" } },
        business: { legalName: "ACME Operations GmbH" },
        workflow: { name: "Send document" },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.subject).toBe("Document for Send document");
      expect(result.data.html).toContain("https:&#x2F;&#x2F;example.test&#x2F;document");
    }
  });

  test("rejects unknown Liquid roots", () => {
    const result = validateEmailTemplateWrite({
      subject: "{{ secret.token }}",
      html: "<p>{{ data.name }}</p>",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('email subject uses unknown Liquid variable "secret".');
  });

  test("localizes validation errors for regional German locales", () => {
    const result = validateEmailTemplateWrite(
      {
        subject: "{{ secret.token }}",
        html: "<p>{{ data.name }}</p>",
      },
      "de-CH",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("E-Mail-Betreff verwendet die unbekannte Liquid-Variable „secret“");
  });
});
