import { describe, expect, test } from "bun:test";

const source = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("table mutation policy UI contract", () => {
  test("uses progressive source choices and previews affected entry points", async () => {
    const dialog = await source("./MutationPolicyDialog.tsx");
    const messages = await source("./messages.ts");

    expect(dialog).toContain("title={t().chooseChangeSources}");
    expect(dialog).toContain("label={t().all}");
    expect(messages).toContain('directEditing: "Direct editing and record API"');
    expect(messages).toContain('forms: "Forms"');
    expect(messages).toContain('workflowsActions: "Workflows and actions"');
    expect(dialog).toContain('["mutation-policy"].impact.$post');
    expect(dialog).toContain("title={t().stopsWorking}");
    expect(dialog).toContain("confirmationPhrase: props.args.tableName");
    expect(dialog).toContain("title: t().freezeQuestion");
  });

  test("keeps mutation policy in the table data-integrity settings", async () => {
    const settings = await source("./TableAdminDialogs.tsx");

    expect(settings).toContain("title={t().dataIntegrity}");
    expect(settings).toContain("title={t().recordChanges}");
    expect(settings).toContain("openMutationPolicyDialog");
  });
});
