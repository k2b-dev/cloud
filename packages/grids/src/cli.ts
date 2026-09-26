import { type CliArgSpec, type CliFlagSpec, type CloudCliContext, cloudCliLanguage, type command, defineCliCommands } from "@k2b/cloud/cli";
import { accessCommands } from "./cli/access";
import { baseCrudCommands } from "./cli/bases";
import { customAppCommands } from "./cli/custom-apps";
import { documentCommands, documentTemplateCommands } from "./cli/documents";
import { evidenceCommands } from "./cli/evidence";
import { formCommands } from "./cli/forms";
import { GRIDS_CLI_HELP_DE } from "./cli/help-de";
import { navigationCommands } from "./cli/navigation";
import { publishedAppCommands } from "./cli/published-apps";
import { recordDiscussionCommands } from "./cli/record-discussion";
import { recordEventCommands } from "./cli/record-events";
import { recordCommands, snapshotCommands } from "./cli/records";
import { fieldCommands, tableCommands } from "./cli/schema";
import { baseTemplateCommands } from "./cli/templates";
import { formulaCommands, gqlCommands, viewCommands } from "./cli/views-gql";
import { emailTemplateCommands, workflowCommands, workflowEmailCommands, workflowRunCommands } from "./cli/workflows";

export const gridsCommands = [
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
];

type CommandDefinition = ReturnType<typeof command>;

/** Help text in the request language; English text is the catalog key, and command syntax stays unchanged. */
const helpText = (locale: string | undefined) => {
  const german = cloudCliLanguage(locale) === "de";
  return <T extends string | undefined>(text: T): T => (german && text ? ((GRIDS_CLI_HELP_DE[text] ?? text) as T) : text);
};

const localizeSpecs = <T extends CliArgSpec | CliFlagSpec>(specs: Record<string, T> | undefined, t: ReturnType<typeof helpText>) =>
  specs && Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, { ...spec, description: t(spec.description) }]));

export const localizeGridsCommand = (definition: CommandDefinition, locale: string | undefined): CommandDefinition => {
  const t = helpText(locale);
  return {
    ...definition,
    summary: t(definition.summary),
    description: t(definition.description),
    args: localizeSpecs(definition.args, t),
    flags: localizeSpecs(definition.flags, t),
  };
};

export const GRIDS_CLI_SUMMARY =
  "Manage Grids bases, schema, records, forms, Apps, views, GQL, documents, templates, and workflows through the Grids HTTP API.";

export const GRIDS_GROUP_SUMMARIES: Readonly<Record<string, string>> = {
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
};

const gridsCli = (locale?: string) => {
  const t = helpText(locale);
  return defineCliCommands({
    name: "grids",
    summary: t(GRIDS_CLI_SUMMARY),
    groupSummaries: Object.fromEntries(Object.entries(GRIDS_GROUP_SUMMARIES).map(([path, summary]) => [path, t(summary)])),
    commands: gridsCommands.map((definition) => localizeGridsCommand(definition, locale)),
  });
};

const module = gridsCli();
export default {
  ...module,
  help: (locale?: string) => gridsCli(locale).help!(),
  run: (ctx: CloudCliContext) => gridsCli(ctx.options.locale).run(ctx),
};
