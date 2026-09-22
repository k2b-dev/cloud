import { z } from "zod";
import type { DocumentArtifactStreamDraft, DocumentProfile } from "../document-profiles";
import { DOCUMENT_ZIP_MAX_BYTES } from "../service/document-zip-archive";
import { DocumentZipManifestSchema, documentZipProvenance, writeDocumentZip } from "../service/document-zip-output";

const zipInput = z
  .object({
    filename: z.string().trim().min(1).max(255).optional(),
    archive: DocumentZipManifestSchema,
  })
  .strict();

/**
 * Packages stored Document files selected by a workflow query. The archive is
 * streamed straight into the artifact store while the Document is issued;
 * the profile input is the frozen manifest, never the file bytes.
 */
export const zipDocumentProfile: DocumentProfile<z.infer<typeof zipInput>, DocumentArtifactStreamDraft> = {
  id: "grids.zip",
  version: 1,
  title: "ZIP package",
  description: "ZIP archive of stored Document files selected from captured query rows or included generated Documents.",
  rendererVersion: "grids-zip-v1",
  validatorVersion: "grids-zip-v1",
  primaryArtifact: { key: "zip", mediaType: "application/zip" },
  input: zipInput,
  formatNumber: ({ value }) => `ZIP-${value}`,
  issue(input, context) {
    return {
      output: documentZipProvenance(input.archive),
      artifacts: [
        {
          key: "zip",
          filename: input.filename ?? `${context.number}.zip`,
          mediaType: "application/zip",
          stream: {
            maxBytes: DOCUMENT_ZIP_MAX_BYTES,
            write: async (client, sink) => {
              await writeDocumentZip(
                { manifest: input.archive, modifiedAt: context.issuedAt, ...(context.heartbeat ? { heartbeat: context.heartbeat } : {}) },
                client,
                sink,
              );
            },
          },
        },
      ],
      validationStatus: "valid",
      validationReport: { fileCount: input.archive.entries.length, sourceBytes: input.archive.sourceBytes },
    };
  },
};
