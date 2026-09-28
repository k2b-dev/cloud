import { describe, expect, test } from "bun:test";
import {
  escapeMailEditableMarkdownValue,
  escapeMailMarkdownValue,
  migrateReferenceTemplateToLiquid,
  migrateWorkflowTextTemplateToLiquid,
  renderMailLiquidTemplate,
  renderMailWorkflowTemplate,
  validateMailLiquidTemplate,
} from "./template-rendering";

describe("Mail Liquid templates", () => {
  test("renders strict text and Mail filters", () => {
    expect(renderMailLiquidTemplate("REF-{{ year }}-{{ sequence | pad_start: 6 }}", { year: 2026, sequence: 42n })).toEqual({
      ok: true,
      data: "REF-2026-000042",
    });
  });

  test("escapes values inserted into Markdown", () => {
    expect(escapeMailMarkdownValue("*Hello* <script>")).toBe("&#42;Hello&#42; &lt;script&gt;");
    expect(renderMailLiquidTemplate("Hello {{ name }}", { name: "**admin**" }, "markdown")).toEqual({
      ok: true,
      data: "Hello &#42;&#42;admin&#42;&#42;",
    });
  });

  test("keeps values readable in editable Markdown", () => {
    expect(renderMailLiquidTemplate("Reach me at {{ email }}", { email: "ada@example.test" }, "editable_markdown")).toEqual({
      ok: true,
      data: "Reach me at ada@example.test",
    });
    for (const value of [
      "grace_hopper@example.test",
      "Smith & Sons",
      "Re: Offer #42 2026-07 (v2) - 50% off!",
      "a=b, c > d, 10:30",
      "Zoë_Ünal",
    ]) {
      expect(escapeMailEditableMarkdownValue(value)).toBe(value);
    }
  });

  test("escapes only Markdown, HTML, and Liquid syntax in editable Markdown", () => {
    expect(escapeMailEditableMarkdownValue("**a** _b_ `c` ~d~ ^e^ ==f== $g$ h|i [j](k) <b> &amp; {{ l }} {% m %} n\\")).toBe(
      "\\*\\*a\\*\\* \\_b\\_ \\`c\\` \\~d\\~ \\^e\\^ \\=\\=f\\=\\= \\$g\\$ h\\|i \\[j\\](k) \\<b> \\&amp; \\{\\{ l \\}\\} \\{\\% m %\\} n\\\\",
    );
    expect(escapeMailEditableMarkdownValue("# a\n- b\n+ c\n1. d\n2) e\n> f\n:::note\n:--\n=\n  - g")).toBe(
      "\\# a\n\\- b\n\\+ c\n1\\. d\n2\\) e\n\\> f\n\\:\\:\\:note\n\\:--\n\\=\n  \\- g",
    );
    expect(escapeMailEditableMarkdownValue("    $a\n\t- b")).toBe("   \\$a\n   \\- b");
    expect(escapeMailEditableMarkdownValue("Ticket # C# #42 #")).toBe("Ticket # C# #42 \\#");
    expect(escapeMailEditableMarkdownValue("a\r# b\r- c\r\n> d\r    $e #\r")).toBe("a\n\\# b\n\\- c\n\\> d\n   \\$e \\#\n");
    expect(escapeMailMarkdownValue("    $a\n\t- b")).toBe("   &#36;a\n   &#45; b");
  });

  test("rejects unknown roots and invalid filters", () => {
    expect(validateMailLiquidTemplate("{{ actor.email }}", { allowedRoots: ["mailbox"] })).toMatchObject({ ok: false });
    expect(validateMailLiquidTemplate("{{ actor.email | missing_filter }}")).toMatchObject({ ok: false });
  });

  test("renders workflow inputs, context, and saved step values from one snapshot", () => {
    const rendered = renderMailWorkflowTemplate(
      {
        invocation: {
          workflowId: "workflow",
          mode: "execute",
          channel: "mail",
          actor: { userId: "user" },
          inputs: { message: { subject: "Request" } },
          idempotencyKey: "run",
          occurredAt: "2026-07-28T12:00:00.000Z",
          context: { mailboxId: "mailbox" },
        },
        variableSnapshot: () => ({ reference: { value: "REF-42" } }),
      },
      "{{ inputs.message.subject }} / {{ context.mailboxId }} / {{ reference.value }}",
    );

    expect(rendered).toBe("Request / mailbox / REF-42");
  });

  test("migrates embedded workflow expressions", () => {
    expect(migrateWorkflowTextTemplateToLiquid("Re: ${{ inputs.message.subject }} / ${{ reference.value }}")).toBe(
      "Re: {{ inputs.message.subject }} / {{ reference.value }}",
    );
  });

  test("migrates legacy reference tokens", () => {
    expect(migrateReferenceTemplateToLiquid("REF-{year}-{sequence:6}")).toBe("REF-{{ year }}-{{ sequence | pad_start: 6 }}");
    expect(migrateReferenceTemplateToLiquid("REF-{{year}}-{sequence}")).toBe("REF-{{year}}-{{ sequence }}");
  });
});
