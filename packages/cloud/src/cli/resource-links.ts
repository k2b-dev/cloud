import { type CloudResourceRef, cloudResourceHref } from "../contracts/capabilities";
import type { CloudCliContext } from "./index";

export const cloudResourceUrl = (ctx: Pick<CloudCliContext, "options">, ref: CloudResourceRef): string =>
  new URL(cloudResourceHref(ref), ctx.options.server).href;

/** The resource id must be the id its Type's reader accepts. */
export const withCloudResourcePermalink = <T extends { id: string }>(
  ctx: Pick<CloudCliContext, "options">,
  type: CloudResourceRef["type"],
  resource: T,
) => ({ ...resource, permalink: cloudResourceUrl(ctx, { type, id: resource.id }) });
