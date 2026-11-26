import type { AuthContext } from "@k2b/cloud/server";
import { ssr } from "../../config";
import { agentIdFromPath } from "./agent-id";
import { legacyAgentHref } from "./agent-keys";

/**
 * An agent's page from before the one account record: it leads to the record at `/app/accounts/users/:id` with the same
 * order and open key. An id that is no UUID stays a 404, as before.
 */
export default ssr<AuthContext>(async (c) => {
  const id = agentIdFromPath(c.req.param("id"));
  if (!id) return c.notFound();
  return c.redirect(legacyAgentHref(id, new URL(c.req.url).searchParams), 302);
});
