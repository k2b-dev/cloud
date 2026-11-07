import type { SignatureValue } from "@k2b/ui";
import { z } from "zod";

/** The example's domain view. Credentials and signatures are never part of this read model. */
export const VisitDocumentSchema = z.object({
  id: z.enum(["contract", "receipt"]),
  revision: z.number().int().positive(),
  title: z.string(),
  paragraphs: z.array(z.string()),
  receiptAmount: z.string().optional(),
  signed: z.boolean(),
});
export const VisitViewSchema = z.object({ id: z.uuid(), customerName: z.string(), documents: z.array(VisitDocumentSchema).max(2) });
export const KioskSnapshotSchema = z.object({ device: z.object({ name: z.string() }).nullable(), visit: VisitViewSchema.nullable() });
export type VisitDocument = z.infer<typeof VisitDocumentSchema>;
export type VisitView = z.infer<typeof VisitViewSchema>;
export type KioskSnapshot = z.infer<typeof KioskSnapshotSchema>;
export type SignInput = { documentId: VisitDocument["id"]; revision: number; signature: SignatureValue; consent: true };

/** Browser adapter to the example's typed HTTP routes; also the UI test seam. */
export type KioskApi = {
  snapshot(signal: AbortSignal): Promise<KioskSnapshot>;
  scan(text: string, signal: AbortSignal): Promise<void>;
  acceptsQr(text: string): boolean;
  sign(attempt: string, input: SignInput, signal: AbortSignal): Promise<void | { completed: boolean }>;
  reconcile(attempt: string, signal: AbortSignal): Promise<"committed" | "absent" | "completed">;
  end(attempt: string, signal: AbortSignal): Promise<void>;
};

export class KioskFailure extends Error {
  constructor(readonly code: "expired" | "forbidden" | "conflict" | "unavailable" | "qr_unavailable") {
    super(code);
  }
}
