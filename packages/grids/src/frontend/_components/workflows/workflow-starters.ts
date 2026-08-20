import type { PublicTable } from "../../../api/public-dto";

export type WorkflowStarter = {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  launcher: {
    name: string;
    config: {
      kind: "bulk";
      input: string;
      profile: "closeSelection";
    };
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
