import type { PublicField, PublicTable } from "../../../api/public-dto";
import type { CorrectionDraftIntent, GridsWorkflowLauncherConfig } from "../../../workflows/contracts";

export type WorkflowStarter = {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  launcher: {
    name: string;
    config: GridsWorkflowLauncherConfig;
  };
};

export const closeSelectionWorkflowStarter = (table: Pick<PublicTable, "id" | "name">): WorkflowStarter => ({
  name: `Close selected ${table.name} Records`,
  description: "Finalize an exact reviewed selection, or request Four-eyes Finalization when the Table requires approval.",
  enabled: true,
  source: `inputs:
  records:
    type: recordList
    table: ${JSON.stringify(table.id)}
    required: true
  closeMode:
    type: text
    required: true
  closePolicyRevision:
    type: number
    required: true
steps:
  - forEach: inputs.records
    as: record
    do:
      - closeRecord:
          record: record
          expectedMode: inputs.closeMode
          expectedPolicyRevision: inputs.closePolicyRevision
`,
  launcher: {
    name: "Close selection",
    config: {
      kind: "bulk",
      input: "records",
      profile: "closeSelection",
    },
  },
});

export const correctionDraftWorkflowStarter = (params: {
  table: Pick<PublicTable, "id" | "name">;
  intent: CorrectionDraftIntent;
  typeField: Pick<PublicField, "id">;
  typeValue: string;
  originalField: Pick<PublicField, "id">;
  copyFields: Array<Pick<PublicField, "id">>;
}): WorkflowStarter => {
  const intentLabel = params.intent === "cancellation" ? "cancellation" : "correction";
  return {
    name: `Create ${params.table.name} ${intentLabel} Draft`,
    description: `Create one ${intentLabel} Draft linked to an unchanged finalized original Record.`,
    enabled: true,
    source: `inputs:
  original:
    type: record
    table: ${JSON.stringify(params.table.id)}
    required: true
steps:
  - createCorrectionDraft:
      original: inputs.original
      intent: ${params.intent}
      typeField: ${JSON.stringify(params.typeField.id)}
      typeValue: ${JSON.stringify(params.typeValue)}
      originalField: ${JSON.stringify(params.originalField.id)}
${
  params.copyFields.length > 0
    ? `      copyFields:\n${params.copyFields.map((field) => `        - ${JSON.stringify(field.id)}`).join("\n")}\n`
    : ""
}
`,
    launcher: {
      name: `Create ${intentLabel}`,
      config: {
        kind: "record",
        input: "original",
        profile: "correctionDraft",
        intent: params.intent,
      },
    },
  };
};
