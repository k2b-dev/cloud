import { ssr } from "../../config";
import { legacyDeletedHref } from "./query";

/** The former deleted-accounts page: its addresses lead to the kind "Gelöschte Konten" of the activity page. */
export default ssr(async (c) => c.redirect(legacyDeletedHref(new URL(c.req.url).searchParams)));
