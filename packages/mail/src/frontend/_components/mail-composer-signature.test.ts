import { describe, expect, test } from "bun:test";
import { defaultSignatureTemplateId, type MailComposerSignatures, signatureOptions } from "./mail-composer-signature";

const signatures: MailComposerSignatures = {
  templates: [
    { id: "Sign01", name: "Mailbox" },
    { id: "Sign02", name: "Personal" },
  ],
  personalDefaults: [{ senderIdentityId: "Send01", templateId: "Sign02" }],
};
const identities = [{ id: "Send01", defaultSignatureTemplateId: "Sign01" }];
const labels = { none: "No signature", default: "Default", unavailable: "Signature of another person" };

describe("composer signatures", () => {
  test("a personal default beats the mailbox default for that sender", () => {
    expect(defaultSignatureTemplateId(signatures, identities, "Send01")).toBe("Sign02");
    expect(defaultSignatureTemplateId({ ...signatures, personalDefaults: [] }, identities, "Send01")).toBe("Sign01");
    expect(defaultSignatureTemplateId(signatures, identities, "Send02")).toBeNull();
  });

  test("ignores archived or invisible defaults and falls back to an available mailbox default", () => {
    expect(defaultSignatureTemplateId({ ...signatures, templates: signatures.templates.slice(0, 1) }, identities, "Send01")).toBe("Sign01");
    expect(defaultSignatureTemplateId({ ...signatures, templates: [] }, identities, "Send01")).toBeNull();
    expect(
      defaultSignatureTemplateId(
        { ...signatures, personalDefaults: [] },
        [{ id: "Send01", defaultSignatureTemplateId: "Unknown" }],
        "Send01",
      ),
    ).toBeNull();
  });

  test("keeps template order after No signature and describes only the sender default", () => {
    expect(signatureOptions(signatures, "Sign01", "Sign02", labels)).toEqual([
      { value: "", label: "No signature" },
      { value: "Sign01", label: "Mailbox" },
      { value: "Sign02", label: "Personal", description: "Default" },
    ]);
  });

  test("keeps an unavailable shared draft signature as the last option", () => {
    const options = signatureOptions(signatures, "Private", "Sign01", labels);
    expect(options.at(-1)).toEqual({ value: "Private", label: "Signature of another person" });
    expect(options).toHaveLength(4);
    expect(signatureOptions(signatures, null, null, labels)).toHaveLength(3);
    expect(signatureOptions(signatures, "Sign01", null, labels)).toHaveLength(3);
  });
});
