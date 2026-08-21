import Decimal from "decimal.js";
import { z } from "zod";
import { type BusinessDocumentProfileSummary, BusinessDocumentProfileSummarySchema } from "./business-document-contracts";

export type BusinessDocumentArtifactDraft = {
  key: string;
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
};

export type BusinessDocumentProfileResult = {
  artifacts: BusinessDocumentArtifactDraft[];
  validationStatus: "valid" | "warning";
  validationReport: Record<string, unknown>;
};

export type BusinessDocumentProfile<TSnapshot extends Record<string, unknown> = Record<string, unknown>> =
  BusinessDocumentProfileSummary & {
    input: z.ZodType<TSnapshot>;
    formatNumber: (context: { value: number; issuedAt: Date }) => string;
    issue(
      snapshot: TSnapshot,
      context: { number: string; issuedAt: Date },
    ): Promise<BusinessDocumentProfileResult> | BusinessDocumentProfileResult;
  };

export const exactDecimalSchema = (options: { scale?: number; nonnegative?: boolean } = {}) =>
  z
    .string()
    .max(200)
    .superRefine((value, ctx) => {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
        ctx.addIssue({ code: "custom", message: "Expected a canonical decimal string" });
        return;
      }
      const decimal = new Decimal(value);
      if (!decimal.isFinite() || (options.nonnegative && decimal.isNegative())) {
        ctx.addIssue({ code: "custom", message: options.nonnegative ? "Expected a non-negative decimal" : "Expected a finite decimal" });
        return;
      }
      const lexicalScale = value.includes(".") ? value.length - value.indexOf(".") - 1 : 0;
      if (options.scale !== undefined && lexicalScale !== options.scale) {
        ctx.addIssue({ code: "custom", message: `Expected exactly ${options.scale} decimal places` });
      }
    });

export const businessDocumentProfiles: readonly BusinessDocumentProfile[] = [];

export const profileKey = (id: string, version: number): string => `${id}@${version}`;

export const profileRegistry = (profiles: readonly BusinessDocumentProfile[]) => {
  const registry = new Map<string, BusinessDocumentProfile>();
  for (const profile of profiles) {
    const summary = BusinessDocumentProfileSummarySchema.safeParse({
      id: profile.id,
      version: profile.version,
      title: profile.title,
      description: profile.description,
      rendererVersion: profile.rendererVersion,
      validatorVersion: profile.validatorVersion,
    });
    if (!summary.success) throw new Error(`Invalid Business Document profile: ${summary.error.issues[0]?.message ?? "unknown error"}`);
    const key = profileKey(profile.id, profile.version);
    if (registry.has(key)) throw new Error(`Duplicate Business Document profile ${key}`);
    registry.set(key, profile);
  }
  return registry;
};
