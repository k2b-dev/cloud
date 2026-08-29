import type { TemplateVariable } from "@k2b/ui";
import type { WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { EmailTemplateSampleDataSchema } from "../../../contracts";
import { workflowMessages } from "./messages";

export const DEFAULT_EMAIL_TEMPLATE_SAMPLE_DATA: Record<string, WorkflowJsonValue> = {
  link: {
    url: "https://cloud.example.org/documents/download/example",
    expiresAt: "31 Dec 2026",
  },
  document: {
    filename: "invoice-2026-001.pdf",
  },
};

export const createDefaultEmailTemplateSampleData = (locale = "en"): Record<string, WorkflowJsonValue> => ({
  link: {
    url: "https://cloud.example.org/documents/download/example",
    expiresAt: locale.toLowerCase().startsWith("de") ? "31. Dez. 2026" : "31 Dec 2026",
  },
  document: { filename: "invoice-2026-001.pdf" },
});

export const EMAIL_TEMPLATE_SYSTEM_VARIABLES: TemplateVariable[] = [
  { name: "app.name", kind: "string" },
  { name: "app.logoSvgDataUrl", kind: "url" },
  { name: "business.legalName", kind: "string" },
  { name: "business.senderLine", kind: "string" },
  { name: "workflow.name", kind: "string" },
  { name: "run.id", kind: "string" },
  { name: "date.iso", kind: "string" },
];

const EMAIL_TEMPLATE_SYSTEM_SAMPLE_VALUES: Record<string, string> = {
  "app.name": "Cloud",
  "app.logoSvgDataUrl": "https://cloud.example.org/logo.svg",
  "business.legalName": "ACME Operations GmbH",
  "business.senderLine": "ACME Operations GmbH · Friedrichstrasse 120 · 10117 Berlin",
  "workflow.name": "Send signed document",
  "run.id": "run_01J2EXAMPLE",
  "date.iso": "2026-07-07",
};

export const createEmailTemplateSystemSampleData = (locale = "en"): Record<string, string> => ({
  ...EMAIL_TEMPLATE_SYSTEM_SAMPLE_VALUES,
  "workflow.name": locale.toLowerCase().startsWith("de")
    ? "Signiertes Dokument senden"
    : EMAIL_TEMPLATE_SYSTEM_SAMPLE_VALUES["workflow.name"]!,
});

const variableKind = (value: unknown): TemplateVariable["kind"] => {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
};

const collectDataVariables = (value: unknown, path: string, output: TemplateVariable[]): void => {
  output.push({ name: path, kind: variableKind(value) });
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    collectDataVariables(child, `${path}.${key}`, output);
  }
};

export const emailTemplateVariables = (sampleData: Record<string, WorkflowJsonValue>): TemplateVariable[] => {
  const dataVariables: TemplateVariable[] = [];
  collectDataVariables(sampleData, "data", dataVariables);
  return [...dataVariables, ...EMAIL_TEMPLATE_SYSTEM_VARIABLES];
};

const setNestedValue = (target: Record<string, unknown>, path: string[], value: string): void => {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!;
    const next = cursor[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      const child: Record<string, unknown> = {};
      cursor[key] = child;
      cursor = child;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[path[path.length - 1]!] = value;
};

export const emailTemplatePreviewContext = (
  sampleData: Record<string, unknown>,
  systemValues: Record<string, string>,
): Record<string, unknown> => {
  const context: Record<string, unknown> = { data: sampleData };
  for (const variable of EMAIL_TEMPLATE_SYSTEM_VARIABLES) {
    setNestedValue(
      context,
      variable.name.split("."),
      systemValues[variable.name] ?? EMAIL_TEMPLATE_SYSTEM_SAMPLE_VALUES[variable.name] ?? variable.name,
    );
  }
  return context;
};

type ParsedEmailTemplateSampleData = { ok: true; data: Record<string, WorkflowJsonValue> } | { ok: false; error: string };

export const parseEmailTemplateSampleData = (source: string, locale = "en"): ParsedEmailTemplateSampleData => {
  const t = workflowMessages.resolve([locale]).t;
  try {
    const parsed = JSON.parse(source) as unknown;
    const result = EmailTemplateSampleDataSchema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, error: result.error.issues[0]?.message ?? t.sampleDataObject };
    }
    return { ok: true, data: result.data };
  } catch {
    return { ok: false, error: t.sampleDataJson };
  }
};
