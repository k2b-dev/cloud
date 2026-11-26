import { ssr } from "../../config";
import { legacyRemindersHref } from "./query";

/** The former reminder history: its addresses lead to the kind "Erinnerungen" of the activity page. */
export default ssr(async (c) => c.redirect(legacyRemindersHref(new URL(c.req.url).searchParams)));
