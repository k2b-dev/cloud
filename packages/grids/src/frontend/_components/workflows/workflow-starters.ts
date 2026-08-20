import type { PublicField, PublicTable } from "../../../api/public-dto";
import type { GridsWorkflowLauncherConfig } from "../../../workflows/contracts";

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
  typeField: Pick<PublicField, "id">;
  typeValue: string;
  originalField: Pick<PublicField, "id">;
}): WorkflowStarter => ({
  name: `Create ${params.table.name} correction Draft`,
  description: "Create one Draft linked to an unchanged finalized original Record.",
  enabled: true,
  source: `inputs:
  original:
    type: record
    table: ${JSON.stringify(params.table.id)}
    required: true
steps:
  - createCorrectionDraft:
      original: inputs.original
      typeField: ${JSON.stringify(params.typeField.id)}
      typeValue: ${JSON.stringify(params.typeValue)}
      originalField: ${JSON.stringify(params.originalField.id)}
`,
  launcher: {
    name: "Create correction",
    config: {
      kind: "record",
      input: "original",
      profile: "correctionDraft",
    },
  },
});
