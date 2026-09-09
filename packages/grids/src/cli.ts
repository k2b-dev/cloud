import { defineCliCommands } from "@k2b/cloud/cli";
import { accessCommands } from "./cli/access";
import { baseCrudCommands } from "./cli/bases";
import { customAppCommands } from "./cli/custom-apps";
import { documentCommands, documentTemplateCommands } from "./cli/documents";
import { evidenceCommands } from "./cli/evidence";
import { formCommands } from "./cli/forms";
import { navigationCommands } from "./cli/navigation";
import { publishedAppCommands } from "./cli/published-apps";
import { recordDiscussionCommands } from "./cli/record-discussion";
import { recordEventCommands } from "./cli/record-events";
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
    "apps runtime": "Read and interact with published Grids Apps",
    "apps runtime comments": "Read and manage comments in published Apps",
    "apps runtime files": "Upload, download, and manage files in published Apps",
    bases: "Create, inspect, and manage Grids bases",
    "bases navigation": "Read and replace shared base navigation groups",
    "bases destruction": "Preview, run, and control bounded controlled File destruction",
    "bases preservation-holds": "List, create, and release preservation holds",
    "bases retention files": "List and download unreferenced Files under a retention floor",
    "bases retention records": "List trashed Records under a retention floor",
    "records finalization": "Request, approve, and reject Four-eyes record Finalization",
    "document-templates": "Create, preview, and manage document templates",
    documents: "Generate, browse, and manage stored documents",
    evidence: "Verify downloaded evidence packages",
    "email-templates": "Create and manage workflow email templates",
    fields: "Create, inspect, and manage table fields",
    forms: "Create, inspect, and submit forms",
    formulas: "Validate formulas and inspect the formula reference",
    gql: "Compile, preview, and run Grids queries",
    records: "Create, query, import, and manage records",
    "records comments": "Read and manage record discussion",
    "record-events": "Inspect and replay delivery failures as platform administrator",
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
    ...navigationCommands,
    ...baseTemplateCommands,
    ...accessCommands,
    ...customAppCommands,
    ...publishedAppCommands,
    ...gqlCommands,
    ...formulaCommands,
    ...tableCommands,
    ...fieldCommands,
    ...recordCommands,
    ...recordDiscussionCommands,
    ...recordEventCommands,
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
