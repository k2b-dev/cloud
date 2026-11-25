/**
 * The old tag page — `/app/notebooks/<id>/tags/<tag>`. A tag is now one filter of the notes list (maintainer GO 25.11.),
 * so this address leads there with the tag set and keeps the search, the page and the presentation mode. The list
 * checks access itself.
 */
import type { AuthContext } from "@k2b/cloud/server";
import { ssr } from "../../../../config";
import { legacyTagHref } from "../../notes/query";

export default ssr<AuthContext>(async (c) =>
  c.redirect(legacyTagHref(c.req.param("id")!, c.req.param("tag") ?? "", new URL(c.req.url).searchParams)),
);
