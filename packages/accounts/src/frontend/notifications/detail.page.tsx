import { ssr } from "../../config";
import { legacyBatchHref } from "./query";

/** The former page of a batch: its addresses lead to the batch's record beside the activity page, every parameter kept. */
export default ssr(async (c) => c.redirect(legacyBatchHref(c.req.param("id") ?? "", new URL(c.req.url).searchParams)));
