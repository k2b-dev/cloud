import { z } from "zod";
import { compileCapabilityManifest } from "../capabilities/testing";
import { CapabilityFileMetadataSchema } from "../contracts/capabilities";

/** Fictional independent app; the same stream declaration is available to third parties. */
export const fileImportManifest = () =>
  compileCapabilityManifest("imports", {
    protocolVersion: 2,
    actions: {
      import: {
        title: "Import file",
        description: "Validate and import a file.",
        input: z.object({ file: CapabilityFileMetadataSchema }).strict(),
        data: z.object({ imported: z.boolean() }).strict(),
        destructive: false,
        openWorld: false,
        idempotency: "required",
        policy: { silent: "shared" },
        review: () => ({
          ok: true,
          data: {
            locale: "en",
            sentence: {
              action: "Import file",
              running: "Importing file",
              done: "Imported file",
              confirm: "Import",
              decline: "Cancel",
            },
            slots: {},
            scope: "import",
          },
        }),
        run: (input, context) => ({
          ok: true,
          data: {
            data: { imported: false },
            stream: {
              ...input.file,
              id: context.idempotencyKey!,
              direction: "write",
              expiresAt: "2026-11-07T12:05:00.000Z",
            },
          },
        }),
        stream: {
          direction: "write",
          maxBytes: 100 * 1024 * 1024,
          write: async (_stream, body) => {
            await new Response(body).arrayBuffer();
            return { data: { imported: true } };
          },
          status: async () => ({ state: "open" }),
          abort: async () => {},
        },
      },
    },
  });
