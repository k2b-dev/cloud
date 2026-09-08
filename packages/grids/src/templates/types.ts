import type { WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import type { CustomAppDefinition } from "../custom-apps/contracts";
import type { GridsWorkflowLauncherConfig } from "../workflows/contracts";

type TemplateRefKind = "table" | "field" | "record" | "view" | "form" | "launcher" | "documentTemplate";

export type TemplateRef = {
  $ref: TemplateRefKind;
  key: string;
};

type TemplateFormulaExpression = {
  $formula: Array<string | TemplateRef>;
};

type TemplateViewColumnsRef = {
  $ref: "viewColumns";
  key: string;
};

type TemplateResolvable<T> = T extends string
  ? T | TemplateRef | TemplateFormulaExpression
  : T extends Array<infer Item>
    ? [Item] extends [string]
      ? Array<TemplateResolvable<Item>> | TemplateViewColumnsRef
      : Array<TemplateResolvable<Item>>
    : T extends object
      ? { [Key in keyof T]: TemplateResolvable<T[Key]> }
      : T;

export type TemplateDateExpression = {
  $date: "current_month";
  day: number;
  monthOffset?: number;
};

export type TemplateField = {
  key: string;
  name: string;
  type: string;
  description?: string | null;
  icon?: string | null;
  config?: Record<string, unknown>;
  required?: boolean;
  presentable?: boolean;
  hideInTable?: boolean;
  defaultValue?: unknown;
  indexed?: boolean;
  uniqueConstraint?: boolean;
};

type TemplateTable = {
  key: string;
  name: string;
  description?: string | null;
  displayConfig?: unknown;
  fields: TemplateField[];
};

type TemplateRecordFile = {
  field: string;
  filename: string;
  dataUrl: string;
};

type TemplateRecord = {
  key: string;
  table: string;
  values: Record<string, unknown>;
  files?: TemplateRecordFile[];
};

type TemplateView = {
  key: string;
  table: string;
  name: string;
  source?: unknown;
  ui?: unknown;
  shared?: boolean;
};

type TemplateForm = {
  key: string;
  table: string;
  name: string;
  isPublic?: boolean;
  config: Record<string, unknown>;
};

type TemplateCustomApp = {
  key: string;
  definition: TemplateResolvable<Omit<CustomAppDefinition, "id" | "baseId" | "shortId">>;
};

type TemplateDocumentTemplate = {
  key: string;
  table: string;
  starterId: string;
  name?: string;
  description?: string | null;
  source?: unknown;
  enabled?: boolean;
};

type TemplateEmailTemplate = {
  key: string;
  name: string;
  description?: string | null;
  subject: string;
  html: string;
  sampleData?: Record<string, WorkflowJsonValue>;
  enabled?: boolean;
};

type TemplateWorkflow = {
  key: string;
  name: string;
  description?: string | null;
  source: string;
  enabled?: boolean;
};

type TemplateWorkflowLauncher = {
  key: string;
  workflow: string;
  name: string;
  config: GridsWorkflowLauncherConfig;
  enabled?: boolean;
};

export type GridTemplate = {
  id: string;
  name: string;
  description: string;
  highlights: [string, string, string];
  icon: string;
  baseName: string;
  baseDescription?: string | null;
  tables: TemplateTable[];
  records?: TemplateRecord[];
  views?: TemplateView[];
  forms?: TemplateForm[];
  customApps?: TemplateCustomApp[];
  documentTemplates?: TemplateDocumentTemplate[];
  emailTemplates?: TemplateEmailTemplate[];
  workflows?: TemplateWorkflow[];
  workflowLaunchers?: TemplateWorkflowLauncher[];
};

export const table = (key: string): TemplateRef => ({ $ref: "table", key });
export const field = (key: string): TemplateRef => ({ $ref: "field", key });
export const record = (key: string): TemplateRef => ({ $ref: "record", key });
export const view = (key: string): TemplateRef => ({ $ref: "view", key });
export const viewColumns = (key: string): TemplateViewColumnsRef => ({ $ref: "viewColumns", key });
export const form = (key: string): TemplateRef => ({ $ref: "form", key });
export const documentTemplate = (key: string): TemplateRef => ({ $ref: "documentTemplate", key });
export const launcher = (key: string): TemplateRef => ({
  $ref: "launcher",
  key,
});
export const formula = (...parts: Array<string | TemplateRef>): TemplateFormulaExpression => ({ $formula: parts });
export const currentMonthDate = (day: number, monthOffset = 0): TemplateDateExpression => ({
  $date: "current_month",
  day,
  ...(monthOffset === 0 ? {} : { monthOffset }),
});
