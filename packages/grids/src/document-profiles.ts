import Decimal from "decimal.js";
import { z } from "zod";
import { type DocumentProfileSummary, DocumentProfileSummarySchema } from "./document-profile-contracts";
import { germanBillingProfile, germanEInvoiceProfile } from "./document-profiles/einvoice-de";
import { csvDocumentProfile, jsonDocumentProfile, pdfTableDocumentProfile, xmlTableDocumentProfile } from "./document-profiles/table";
import type { ProtectedFileStream } from "./service/files";

export type DocumentArtifactDraft = {
  key: string;
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
};

/** Content produced on the storing transaction instead of a buffer; see `createProtectedStreamed`. */
export type DocumentArtifactStreamDraft = {
  key: string;
  filename: string;
  mediaType: string;
  stream: ProtectedFileStream;
};

export type DocumentProfileArtifactDraft = DocumentArtifactDraft | DocumentArtifactStreamDraft;

type DocumentProfileResult<TArtifact extends DocumentProfileArtifactDraft> = {
  /** Derived machine-readable values, stored with the issued artifacts. */
  output?: Record<string, unknown>;
  artifacts: TArtifact[];
  validationStatus: "valid" | "warning" | "unchecked";
  validationReport: Record<string, unknown>;
};

export type DocumentProfile<
  TSnapshot extends Record<string, unknown> = Record<string, unknown>,
  TArtifact extends DocumentProfileArtifactDraft = DocumentArtifactDraft,
> = DocumentProfileSummary & {
  input: z.ZodType<TSnapshot>;
  formatNumber: (context: { value: number; issuedAt: Date }) => string;
  issue(
    snapshot: TSnapshot,
    context: {
      number: string;
      issuedAt: Date;
      /** Long-running issuance keeps its workflow lease alive; throws once the run is canceled. */
      heartbeat?: () => Promise<void>;
    },
  ): Promise<DocumentProfileResult<TArtifact>> | DocumentProfileResult<TArtifact>;
};

/** Any installed profile, whether it renders buffers or streams its artifact. */
export type InstalledDocumentProfile = DocumentProfile<Record<string, unknown>, DocumentProfileArtifactDraft>;

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

export const documentProfiles: readonly DocumentProfile[] = [
  germanEInvoiceProfile,
  germanBillingProfile,
  csvDocumentProfile,
  jsonDocumentProfile,
  pdfTableDocumentProfile,
  xmlTableDocumentProfile,
];

export const profileKey = (id: string, version: number): string => `${id}@${version}`;

export const profileRegistry = (profiles: readonly InstalledDocumentProfile[]) => {
  const registry = new Map<string, InstalledDocumentProfile>();
  for (const profile of profiles) {
    const summary = DocumentProfileSummarySchema.safeParse({
      id: profile.id,
      version: profile.version,
      title: profile.title,
      description: profile.description,
      rendererVersion: profile.rendererVersion,
      validatorVersion: profile.validatorVersion,
      primaryArtifact: profile.primaryArtifact,
    });
    if (!summary.success) throw new Error(`Invalid profiled Document profile: ${summary.error.issues[0]?.message ?? "unknown error"}`);
    const key = profileKey(profile.id, profile.version);
    if (registry.has(key)) throw new Error(`Duplicate profiled Document profile ${key}`);
    registry.set(key, profile);
  }
  return registry;
};
