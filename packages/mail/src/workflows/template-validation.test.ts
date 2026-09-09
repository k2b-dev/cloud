import { describe, expect, test } from "bun:test";
import { compileWorkflow } from "@k2b/cloud/workflows/language";
import { mailWorkflows } from "./module";
import { validateMailWorkflowTemplates } from "./template-validation";

const diagnosticsFor = async (source: string) => {
  const compiled = await compileWorkflow(source, mailWorkflows);
  if (!compiled.ok) throw new Error(compiled.diagnostics[0]?.message);
  return validateMailWorkflowTemplates(compiled.ir);
};

describe("Mail workflow Liquid validation", () => {
  test("accepts Liquid in Mail text fields while preserving typed workflow values", async () => {
    expect(
      await diagnosticsFor(`
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
steps:
  - createDraft:
      sender: Support
      to: []
      subject: "Re: {{ inputs.message.subject }}"
      body: "Hello {{ inputs.message.sender.0.name }}"
      format: markdown
      saveAs: draft
`),
    ).toEqual([]);
  });

  test("rejects legacy interpolation only in text-template fields", async () => {
    const diagnostics = await diagnosticsFor(`
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
steps:
  - automaticReply:
      message: "\${{ inputs.message }}"
      conversation: "\${{ inputs.conversation }}"
      sender: Support
      subject: "Re: \${{ inputs.message.subject }}"
      body: Thanks
      schedule:
        mode: always
`);
    expect(diagnostics).toMatchObject([{ code: "MAIL_TEMPLATE_LEGACY_SYNTAX", path: ["steps", 0, "automaticReply", "subject"] }]);
  });
});
