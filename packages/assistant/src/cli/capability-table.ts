import { bindView, blocksText } from "@k2b/cloud/blocks";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { CapabilitySemanticLinkSchema, capabilityDataAtPath } from "@k2b/cloud/contracts";
import { terminalSafeText } from "./terminal";

/** Human output only; the original result and machine output keep their complete envelope. */
export const printCapabilityView = (ctx: CloudCliContext, result: unknown): boolean => {
  const raw = capabilityDataAtPath(result, ["view"]);
  if (!raw) return false;
  let text: string;
  try {
    text = blocksText(bindView(raw, capabilityDataAtPath(result, ["data"])).blocks, { locale: ctx.options.locale, timeZone: "UTC" });
  } catch {
    return false;
  }
  ctx.print();
  const summary = capabilityDataAtPath(result, ["summary"]);
  if (typeof summary === "string") ctx.print(terminalSafeText(summary));
  ctx.print(terminalSafeText(text));
  if (capabilityDataAtPath(result, ["page", "hasMore"]) === true) ctx.print("More results are available on the next page.");
  const links = capabilityDataAtPath(result, ["links"]);
  if (Array.isArray(links))
    for (const value of links) {
      const parsed = CapabilitySemanticLinkSchema.safeParse(value);
      if (!parsed.success) continue;
      const href = ctx.options.server ? new URL(parsed.data.href, ctx.options.server).href : parsed.data.href;
      ctx.print(`${terminalSafeText(parsed.data.title ?? parsed.data.rel)}: ${terminalSafeText(href)}`);
    }
  ctx.print();
  return true;
};
