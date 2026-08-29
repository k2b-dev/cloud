import type { PublicField, PublicTable } from "../../../api/public-dto";
import type { CorrectionDraftIntent, GridsWorkflowLauncherConfig } from "../../../workflows/contracts";
import { workflowMessages } from "./messages";

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

export const closeSelectionWorkflowStarter = (table: Pick<PublicTable, "id" | "name">, locale = "en"): WorkflowStarter => ({
  name: workflowMessages.resolve([locale]).t.closeSelectedRecords({ table: table.name }),
  description: workflowMessages.resolve([locale]).t.closeSelectionDescription,
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
    name: workflowMessages.resolve([locale]).t.closeSelection,
    config: {
      kind: "bulk",
      input: "records",
      profile: "closeSelection",
    },
  },
});

export const correctionDraftWorkflowStarter = (
  params: {
    table: Pick<PublicTable, "id" | "name">;
    intent: CorrectionDraftIntent;
    typeField: Pick<PublicField, "id">;
    typeValue: string;
    originalField: Pick<PublicField, "id">;
    copyFields: Array<Pick<PublicField, "id">>;
  },
  locale = "en",
): WorkflowStarter => {
  const t = workflowMessages.resolve([locale]).t;
  const intentLabel = params.intent === "cancellation" ? t.cancellationIntent : t.correctionIntent;
  return {
    name: t.correctionDraftName({ table: params.table.name, intent: intentLabel }),
    description: t.correctionDraftDescription({ intent: intentLabel }),
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
      name: t.createIntent({ intent: intentLabel }),
      config: {
        kind: "record",
        input: "original",
        profile: "correctionDraft",
        intent: params.intent,
      },
    },
  };
};
