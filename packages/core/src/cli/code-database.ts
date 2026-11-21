import { link, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { arg, command, flag, localizeCloudCliText, printStructured } from "@k2b/cloud/cli";
import { CodeAuthoringErrorSchema } from "../code/authoring-contracts";
import { CodeIdSchema } from "../code/contracts";
import { codeDatabaseStream } from "../code/database-stream";
import { RemoteCodeError } from "./code-request";

export function codeDatabaseCommands(locale?: string) {
  const t = (en: string, de: string) => localizeCloudCliText(locale, { en, de });
  return [
    command("db export", {
      summary: t("Export a Code database as SQLite", "Code-Datenbank als SQLite exportieren"),
      args: { code: arg.required({ description: t("Code ID", "Code-ID") }) },
      flags: {
        out: flag.string({
          required: true,
          description: t("New output file (never overwritten)", "Neue Ausgabedatei (wird nie überschrieben)"),
        }),
      },
      async run({ ctx, args, flags }) {
        const codeId = CodeIdSchema.parse(args.code);
        const signal = AbortSignal.timeout(120000);
        const response = await ctx.fetch(`/api/code/authoring/database/${codeId}/export`, { method: "GET", signal });
        if (!response.ok) {
          const failure = CodeAuthoringErrorSchema.safeParse(await ctx.readJson(response));
          if (failure.success) throw new RemoteCodeError(failure.data);
          throw new Error(
            t("Database export failed. Retry from the Code page.", "Datenbankexport fehlgeschlagen. Auf der Code-Seite erneut versuchen."),
          );
        }
        // The operator's largest supported per-Code ceiling bounds even servers without Content-Length.
        const maximum = 1073741824;
        const stream = codeDatabaseStream(response, maximum);
        const path = resolve(String(flags.out));
        const partial = `${path}.${crypto.randomUUID()}.part`;
        let bytes = 0;
        const handle = await open(partial, "wx", 0o600).catch(async (error: unknown) => {
          await stream.cancel();
          throw error;
        });
        try {
          const file = handle.createWriteStream();
          const counted = stream.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                bytes += chunk.byteLength;
                controller.enqueue(chunk);
              },
            }),
          );
          await pipeline(counted, file, { signal });
          signal.throwIfAborted();
          await link(partial, path);
          const result = { codeId, path, bytes, format: "sqlite" };
          if (!printStructured(ctx, result)) ctx.print(`${t("Exported", "Exportiert")}: ${path}`);
        } finally {
          await handle.close();
          await unlink(partial);
        }
      },
    }),
  ];
}
