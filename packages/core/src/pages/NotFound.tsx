import { getLocale } from "@k2b/cloud/server";
import { ssr } from "../config";
import { corePageMessages } from "./messages";

/** 404 for every address Core does not know: the shared error page, in Core's words, with its way home. */
export default ssr((c) => {
  const t = corePageMessages.resolve([getLocale(c)]).t;
  return ssr.error(c, 404, { title: t.pageNotFound, description: t.wrongTurn, action: { label: t.goHome, href: "/" } });
});
