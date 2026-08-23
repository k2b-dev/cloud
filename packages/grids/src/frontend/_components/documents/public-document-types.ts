import type { z } from "zod";
import type {
  PublicCreateDocumentLinkResponseSchema,
  PublicDocumentLinkListResponseSchema,
  PublicDocumentLinkSchema,
  PublicDocumentBrowseResponseSchema,
  PublicDocumentSchema,
  PublicDocumentTemplateSchema,
  PublicDocumentTemplateSummarySchema,
  PublicRecordSnapshotSchema,
  PublicRecordSnapshotSummarySchema,
} from "../../../api/documents-api-shared";

export type PublicDocumentTemplate = z.infer<typeof PublicDocumentTemplateSchema>;
export type PublicDocumentTemplateSummary = z.infer<typeof PublicDocumentTemplateSummarySchema>;
export type PublicDocument = z.infer<typeof PublicDocumentSchema>;
export type PublicDocumentBrowseResponse = z.infer<typeof PublicDocumentBrowseResponseSchema>;
export type PublicDocumentFolder = z.infer<typeof PublicDocumentBrowseResponseSchema>["folders"][number];
export type PublicDocumentLink = z.infer<typeof PublicDocumentLinkSchema>;
export type PublicDocumentLinkListResponse = z.infer<typeof PublicDocumentLinkListResponseSchema>;
export type PublicCreateDocumentLinkResponse = z.infer<typeof PublicCreateDocumentLinkResponseSchema>;
export type PublicRecordSnapshot = z.infer<typeof PublicRecordSnapshotSchema>;
export type PublicRecordSnapshotSummary = z.infer<typeof PublicRecordSnapshotSummarySchema>;
