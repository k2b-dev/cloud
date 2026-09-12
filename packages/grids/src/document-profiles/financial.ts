import { z } from "zod";
import type { DocumentProfile } from "../document-profiles";
import { renderDatevBatch } from "./datev-csv";
import { DatevBatchSchema } from "./datev-csv-contracts";
import { renderSepaBatch, SEPA_SCHEMA_SHA256 } from "./sepa-xml";
import { SepaBatchSchema } from "./sepa-xml-contracts";

const datevInput = DatevBatchSchema.safeExtend({
  filename: z
    .string()
    .min(1)
    .max(255)
    .regex(/^EXTF_.+\.csv$/),
});
const sepaInput = SepaBatchSchema.safeExtend({
  filename: z
    .string()
    .min(1)
    .max(255)
    .regex(/\.xml$/),
});

// These profiles are available only to confirmed query issuance, not to the
// record-template/preview registry. A template cannot bypass export confirmation.
export const financialQueryProfiles: readonly DocumentProfile[] = [
  {
    id: "grids.datev-csv",
    version: 1,
    title: "DATEV booking batch",
    description: "DATEV 700/13 booking batch in EUR, UTF-8 with BOM.",
    rendererVersion: "grids-datev-700-13-v1",
    validatorVersion: "grids-datev-700-13-v1",
    primaryArtifact: { key: "csv", mediaType: "text/csv" },
    input: datevInput,
    formatNumber: ({ value }) => `DATEV-${value}`,
    issue(raw, context) {
      const { filename, ...batch } = datevInput.parse(raw);
      const rendered = renderDatevBatch(batch, context.issuedAt);
      return {
        artifacts: [{ key: "csv", filename, mediaType: "text/csv", bytes: rendered.bytes }],
        validationStatus: "valid",
        validationReport: {
          rowCount: rendered.rowCount,
          businessCount: rendered.businessCount,
          debitTotal: rendered.debitTotal,
          creditTotal: rendered.creditTotal,
          currency: "EUR",
          imported: false,
        },
      };
    },
  },
  {
    id: "grids.sepa-xml",
    version: 1,
    title: "SEPA credit transfers",
    description: "SEPA SCT pain.001.001.09 using the pinned DK GBIC 5 schema.",
    rendererVersion: "grids-sepa-pain-001-001-09-v1",
    validatorVersion: `dk-gbic-5:${SEPA_SCHEMA_SHA256}`,
    primaryArtifact: { key: "xml", mediaType: "application/xml" },
    input: sepaInput,
    formatNumber: ({ value }) => `SEPA-${value}`,
    async issue(raw, context) {
      const { filename, ...batch } = sepaInput.parse(raw);
      const rendered = await renderSepaBatch(batch, context.issuedAt);
      return {
        artifacts: [{ key: "xml", filename, mediaType: "application/xml", bytes: rendered.bytes }],
        validationStatus: "valid",
        validationReport: {
          rowCount: rendered.rowCount,
          total: rendered.total,
          currency: "EUR",
          schemaSha256: rendered.schemaSha256,
          submitted: false,
        },
      };
    },
  },
];
