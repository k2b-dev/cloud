import type { CODE_SOURCE_TOOLS } from "@k2b/cloud/ai";
import { ok, text } from "@k2b/stdlib";
import type { z } from "zod";
import type { CodeToolContext } from "./context";
import { chatFiles } from "./file-transfer";
import { ArtifactError } from "./identity";
import { reviewMessages } from "./review-messages";

const review = (context: CodeToolContext) => {
  const t = reviewMessages.resolve([context.locale]).t;
  return { t, size: (bytes: number) => text.pprintBytes(bytes, { locale: context.locale }) };
};
async function result<T>(_context: CodeToolContext, run: () => Promise<{ data: T }>) {
  try {
    return ok(await run());
  } catch (error) {
    if (error instanceof ArtifactError)
      return { ok: false as const, error: { code: error.code, message: error.message, status: error.code === "CONFLICT" ? 409 : 403 } };
    throw error;
  }
}
export const chatFileHandlers = {
  code_files: (input, context) => result(context, async () => ({ data: await chatFiles.list(input, context, input.after, input.limit) })),
  code_file_stat: ({ file }, context) =>
    result(context, async () => {
      const found = await chatFiles.read(file, context);
      return {
        data: found
          ? { exists: true, reference: found.reference, size: found.bytes.byteLength, mediaType: found.mediaType }
          : { exists: false },
      };
    }),
  code_file_copy: (input, context) =>
    result<unknown>(context, async () => {
      if (context.review) {
        const target = await chatFiles.destination(input.destination, input.expectedVersion, context);
        const source = await chatFiles.readReference(input.source, context);
        const { t, size } = review(context);
        const place = (scope: "chat" | "project" | "app", title: string, id: string) => t.place({ scope: t[scope], title, id });
        return {
          data: {
            message: [
              t.copyFile({ path: input.source.path }),
              `${t.source}: ${place(input.source.scope, source.title, source.reference.id)} · ${input.source.path}`,
              `${t.target}: ${place(target.scope, target.title, target.id)} · ${input.destination.path}`,
              `${t.size}: ${size(source.bytes.byteLength)}`,
              input.expectedVersion === null ? t.createFile : t.replaceFile,
              t.sharedFiles,
            ].join("\n"),
          },
        };
      }
      return { data: await chatFiles.copy(input.source, input.destination, input.expectedVersion, context, context.signal) };
    }),
} satisfies {
  [K in "code_files" | "code_file_stat" | "code_file_copy"]: (
    input: z.output<(typeof CODE_SOURCE_TOOLS)[K]["input"]>,
    context: CodeToolContext,
  ) => Promise<unknown>;
};
