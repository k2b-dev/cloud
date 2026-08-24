import Decimal from "decimal.js";
import { z } from "zod";
import { type DocumentProfileSummary, DocumentProfileSummarySchema } from "./document-profile-contracts";
import { germanEInvoiceProfile } from "./document-profiles/einvoice-de";

export type DocumentArtifactDraft = {
  key: string;
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
};

export type DocumentProfileResult = {
  artifacts: DocumentArtifactDraft[];
  validationStatus: "valid" | "warning";
  validationReport: Record<string, unknown>;
};

export type DocumentProfile<TSnapshot extends Record<string, unknown> = Record<string, unknown>> = DocumentProfileSummary & {
  input: z.ZodType<TSnapshot>;
  formatNumber: (context: { value: number; issuedAt: Date }) => string;
  issue(
    snapshot: TSnapshot,
    context: {
      number: string;
      issuedAt: Date;
    },
  ): Promise<DocumentProfileResult> | DocumentProfileResult;
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

export const documentProfiles: readonly DocumentProfile[] = [germanEInvoiceProfile];

export const profileKey = (id: string, version: number): string => `${id}@${version}`;

export const profileRegistry = (profiles: readonly DocumentProfile[]) => {
  const registry = new Map<string, DocumentProfile>();
  for (const profile of profiles) {
    const summary = DocumentProfileSummarySchema.safeParse({
      id: profile.id,
      version: profile.version,
      title: profile.title,
      description: profile.description,
      rendererVersion: profile.rendererVersion,
      validatorVersion: profile.validatorVersion,
    });
    if (!summary.success) throw new Error(`Invalid profiled Document profile: ${summary.error.issues[0]?.message ?? "unknown error"}`);
    const key = profileKey(profile.id, profile.version);
    if (registry.has(key)) throw new Error(`Duplicate profiled Document profile ${key}`);
    registry.set(key, profile);
  }
  return registry;
};
