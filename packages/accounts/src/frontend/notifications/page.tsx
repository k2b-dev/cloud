import { ssr } from "../../config";
import { legacyNotificationsHref } from "./query";

/** The former notification list: its addresses lead to the kind "Benachrichtigungen" of the activity page. */
export default ssr(async (c) => c.redirect(legacyNotificationsHref(new URL(c.req.url).searchParams)));
