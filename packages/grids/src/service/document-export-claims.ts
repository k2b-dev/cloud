import { err } from "@k2b/stdlib";
import type { SQL } from "bun";
import { z } from "zod";
import { documentServiceText } from "./document-messages";

const inputSchema = z
  .object({
    baseId: z.uuid(),
    receiptId: z.uuid(),
    destinationKey: z.string().min(1).max(200),
    purpose: z.enum(["accounting", "payment"]),
    businessIds: z.array(z.string().min(1).max(200)).min(1).max(10_000),
  })
  .strict();

/** Call inside the issuance transaction, after current run/access/lease checks.
 * A collision aborts the entire transaction, including any newly inserted claims. */
export const reserveDocumentExportClaims = async (client: SQL, raw: z.input<typeof inputSchema>, locale?: string): Promise<void> => {
  const t = documentServiceText(locale);
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw err.badInput(t.tableOutputInvalid);
  const input = parsed.data;
  const [receipt] = await client<Array<{ confirmed: boolean; matches: boolean }>>`
    SELECT (confirmed_at IS NOT NULL AND confirmation_hash IS NOT NULL AND document_id IS NULL) AS confirmed,
      (frozen_request #>> '{output,header,destinationKey}' = ${input.destinationKey}
        AND frozen_request #>> '{output,kind}' = ${input.purpose === "accounting" ? "datev-csv" : "sepa-xml"}) AS matches
    FROM grids.document_issuances
    WHERE id = ${input.receiptId}::uuid AND base_id = ${input.baseId}::uuid
    FOR UPDATE
  `;
  if (!receipt?.confirmed || !receipt.matches) throw err.conflict(t.financialConfirmationRequired);
  const ids = [...new Set(input.businessIds)].sort();
  // A stable lock order prevents overlapping batches from locking A/B and B/A.
  await client`
    INSERT INTO grids.document_export_claims (base_id, destination_key, purpose, business_id, receipt_id)
    SELECT ${input.baseId}::uuid, ${input.destinationKey}, ${input.purpose}, business_id, ${input.receiptId}::uuid
    FROM unnest(${client.array(ids, "TEXT")}) AS selected(business_id)
    ORDER BY business_id
    ON CONFLICT (base_id, destination_key, purpose, business_id) DO NOTHING
  `;
  const [conflict] = await client<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM grids.document_export_claims
      WHERE base_id = ${input.baseId}::uuid AND destination_key = ${input.destinationKey} AND purpose = ${input.purpose}
        AND business_id = ANY(${client.array(ids, "TEXT")}) AND receipt_id <> ${input.receiptId}::uuid
    ) AS exists
  `;
  if (conflict?.exists) throw err.conflict(t.financialAlreadyReserved);
};
