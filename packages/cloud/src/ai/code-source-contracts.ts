import { z } from "zod";
import { AiFileLocation, AiFileReference } from "./file-reference-contracts";

export const CODE_SOURCE_TOOLS = {
  code_files: {
    description:
      "List authorized files in one explicit chat or Project store. Returns locations, metadata and nextAfter. Use code_file_stat to obtain the opaque version before copying; does not load bytes into model context.",
    input: AiFileLocation.omit({ path: true }).extend({
      after: z.string().max(500).default(""),
      limit: z.number().int().min(1).max(1000).default(100),
    }),
  },
  code_file_stat: {
    description:
      "Inspect one authorized file location. Returns exists plus its exact versioned reference, size and mediaType, never its bytes. Project files require Read, chats ownership.",
    input: z.object({ file: AiFileLocation }).strict(),
  },
  code_file_copy: {
    description:
      "Copy one exact file version between chat and Project stores with fresh review. Source bytes never enter tool output. Project destination requires Write, chat destination ownership. Set expectedVersion null only for a new destination; otherwise use its version from code_file_stat. Source/version, target rights, overwrite and byte limits are rechecked. This grants no access to other files.",
    review: true,
    input: z
      .object({ source: AiFileReference, destination: AiFileLocation, expectedVersion: z.string().min(1).max(128).nullable() })
      .strict(),
  },
} as const;
export type CodeSourceToolName = keyof typeof CODE_SOURCE_TOOLS;
