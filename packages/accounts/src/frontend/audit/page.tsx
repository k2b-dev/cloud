import { ssr } from "../../config";
import { legacyAuditHref } from "./query";

/** The former audit page: its addresses lead to the kind "Protokoll" of the activity page, every filter carried over. */
export default ssr(async (c) => c.redirect(legacyAuditHref(new URL(c.req.url).searchParams)));
