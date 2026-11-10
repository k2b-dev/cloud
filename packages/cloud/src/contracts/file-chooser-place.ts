import { z } from "zod";
import { CapabilityAppIdSchema } from "./capabilities";

/** The folders below a provider's root that the chooser remembers; a deeper place keeps its last levels. */
export const FILE_CHOOSER_PLACE_MAX_FOLDERS = 16;
/** One remembered place with its folder IDs and names; IDs are opaque provider strings of up to 2,048 characters. */
export const FILE_CHOOSER_PLACE_MAX_BYTES = 64 * 1024;

/**
 * Where a person last was in the file chooser: a provider app and the folders below its root, each with the opaque ID
 * its `list` returned and the name shown in the path. `null` means This device. A place is a hint, never access: the
 * provider authorizes every folder again when the chooser opens it.
 */
export const FileChooserPlaceSchema = z
  .object({
    appId: CapabilityAppIdSchema,
    folders: z
      .array(z.object({ id: z.string().min(1).max(2048), name: z.string().min(1).max(255) }).strict())
      .max(FILE_CHOOSER_PLACE_MAX_FOLDERS),
  })
  .strict();
export const FileChooserPlaceBodySchema = z.object({ place: FileChooserPlaceSchema.nullable() }).strict();

export type FileChooserPlace = z.output<typeof FileChooserPlaceSchema>;
