import { createReadStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloudCliContext, localizeCloudCliText } from "@k2b/cloud/cli";
import { writeCodeProject } from "./code-files";
import { request } from "./code-request";

/** Keep at most one source page in memory. Stage structured output privately so a failed pull prints one complete error. */
export async function pullAllCode(ctx: CloudCliContext, root: string) {
  const structured = ctx.options.output !== "text";
  const pretty = ctx.options.output === "json";
  const spool = structured ? join(tmpdir(), `cloud-code-pull-${crypto.randomUUID()}.json`) : null;
  const file = spool ? await open(spool, "wx", 0o600) : null;
  let count = 0;
  try {
    await file?.writeFile(pretty ? '{\n  "version": 1,\n  "items": [' : '{"version":1,"items":[');
    let cursor: string | undefined;
    do {
      const page = await request(ctx, "pullAll", { cursor });
      for (const item of page.items) {
        await writeCodeProject(root, item.config, item.files);
        if (file) {
          const row = pretty ? JSON.stringify(item, null, 2).replace(/^/gm, "    ") : JSON.stringify(item);
          await file.writeFile(`${count ? "," : ""}${pretty ? "\n" : ""}${row}`);
        }
        count++;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    await file?.writeFile(pretty ? `${count ? "\n  " : ""}],\n  "nextCursor": null\n}\n` : '],"nextCursor":null}\n');
    if (spool) {
      for await (const chunk of createReadStream(spool, { encoding: "utf8" })) await ctx.write(chunk);
    } else {
      ctx.print(
        localizeCloudCliText(ctx.options.locale, {
          en: `Pulled ${count} resource Codes.`,
          de: `${count} Ressourcen-Codes geholt.`,
        }),
      );
    }
  } finally {
    await file?.close();
    if (spool) await unlink(spool);
  }
}
