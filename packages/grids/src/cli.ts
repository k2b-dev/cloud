import { defineCliCommands } from "@valentinkolb/cloud/cli";
import { accessCommands } from "./cli/access";
import { baseCrudCommands } from "./cli/bases";
import { customAppCommands } from "./cli/custom-apps";
import { documentCommands, documentTemplateCommands } from "./cli/documents";
import { evidenceCommands } from "./cli/evidence";
import { formCommands } from "./cli/forms";
import { recordCommands, snapshotCommands } from "./cli/records";
import { fieldCommands, tableCommands } from "./cli/schema";
import { baseTemplateCommands } from "./cli/templates";
import { formulaCommands, gqlCommands, viewCommands } from "./cli/views-gql";
import { emailTemplateCommands, workflowCommands, workflowEmailCommands, workflowRunCommands } from "./cli/workflows";

export default defineCliCommands({
  name: "grids",
  summary: "Manage Grids bases, schema, records, forms, Apps, views, GQL, documents, templates, and workflows through the Grids HTTP API.",
  groupSummaries: {
    access: "Manage direct access to Grids resources",
    apps: "Create, validate, and publish Grids Apps",
    bases: "Create, inspect, and manage Grids bases",
    "document-templates": "Create, preview, and manage document templates",
    documents: "Generate, browse, and manage stored documents",
    evidence: "Verify downloaded evidence packages",
    "email-templates": "Create and manage workflow email templates",
    fields: "Create, inspect, and manage table fields",
    forms: "Create, inspect, and submit forms",
    formulas: "Validate formulas and inspect the formula reference",
    gql: "Compile, preview, and run Grids queries",
    records: "Create, query, import, and manage records",
    snapshots: "Create and inspect recursive record snapshots",
    tables: "Create, inspect, and manage tables",
    templates: "Inspect and instantiate built-in base templates",
    views: "Create, inspect, and manage saved views",
    "workflow-emails": "Inspect email deliveries from workflow runs",
    "workflow-launchers": "Create, inspect, and invoke workflow launchers",
    "workflow-runs": "Inspect and control workflow runs",
    workflows: "Create, validate, invoke, and manage workflows",
    "documents links": "Create, inspect, and revoke public document links",
    "records files": "Upload, download, and manage record files",
    "tables combined": "Configure and publish Combined tables",
  },
  commands: [
    ...baseCrudCommands,
    ...baseTemplateCommands,
    ...accessCommands,
    ...customAppCommands,
    ...gqlCommands,
    ...formulaCommands,
    ...tableCommands,
    ...fieldCommands,
    ...recordCommands,
    ...viewCommands,
    ...formCommands,
    ...documentTemplateCommands,
    ...documentCommands,
    ...evidenceCommands,
    ...snapshotCommands,
    ...emailTemplateCommands,
    ...workflowCommands,
    ...workflowRunCommands,
    ...workflowEmailCommands,
  ],
});
