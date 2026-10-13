import { type CloudResourceRef, cloudResourceHref } from "../contracts/capabilities";
import type { CloudCliContext } from "./index";

export const cloudResourceUrl = (ctx: Pick<CloudCliContext, "options">, ref: CloudResourceRef): string =>
  new URL(cloudResourceHref(ref), ctx.options.server).href;
