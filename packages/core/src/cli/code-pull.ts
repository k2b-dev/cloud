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
  const spool = structured ? join(tmpdir(), `cloud-code-pull-${crypto.randomUUID()}.json`) : null;
  const file = spool ? await open(spool, "wx", 0o600) : null;
  let count = 0;
  try {
    await file?.writeFile('{"version":1,"items":[');
    let cursor: string | undefined;
    do {
      const page = await request(ctx, "pullAll", { cursor });
      for (const item of page.items) {
        await writeCodeProject(root, item.config, item.files);
        await file?.writeFile(`${count ? "," : ""}${JSON.stringify(item)}`);
        count++;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    await file?.writeFile('],"nextCursor":null}\n');
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
    if (spool) await unlink(spool);
  }
}
