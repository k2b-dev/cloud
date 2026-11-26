import { ssr } from "../config";

/** 404 for every address Core does not know: the shared error page, the same as for every other missing page. */
export default ssr((c) => ssr.error(c, 404));
