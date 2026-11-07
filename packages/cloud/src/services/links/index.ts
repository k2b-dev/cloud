import { getProcessApplicationPackage } from "../../_internal/process-identity";
import { sql } from "../../runtime/clients";
import { type CreateLinkInput, createLinksStore, type LinkOptions } from "./store";

const store = () => {
  const packageName = getProcessApplicationPackage();
  if (!packageName) throw new Error("Start the application before using one-time links");
  return createLinksStore(sql, packageName);
};

export const links = {
  create: (input: CreateLinkInput, options?: LinkOptions) => store().create(input, options),
  peek: (token: string, input: { purpose: string }, options?: LinkOptions) => store().peek(token, input, options),
  redeem: (token: string, input: { purpose: string }, options?: LinkOptions) => store().redeem(token, input, options),
};
export type { CreatedLink, CreateLinkInput, LinkOptions, PeekedLink, PeekLinkResult, RedeemedLink, RedeemLinkResult } from "./store";
