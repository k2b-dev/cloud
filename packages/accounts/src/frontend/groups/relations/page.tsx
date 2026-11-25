import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor } from "@k2b/cloud/server";
import { accountsAppService as accountsService } from "@k2b/cloud/services";
import { ssr } from "../../../config";
import { toAccountsActor } from "../../../shared/actor";
import { GROUPS_PAGE_PATH } from "../query";
import { legacyRelationsHref } from "./relations-view";

/**
 * The group the former relations page started from when its address named none: the one the relations service picks
 * as the default focus for this administrator, or null when no group contains another.
 */
export const defaultRelationsFocus = async (user: Parameters<typeof toAccountsActor>[0], signal?: AbortSignal): Promise<string | null> => {
  const result = await accountsService.group.relations({
    actor: toAccountsActor(user),
    depth: 2,
    managers: false,
    view: "graph",
    expand: [],
    signal,
  });
  return result.ok ? result.data.focus : null;
};

/**
 * The former relations page (administrators only, as before): the relations are a view of the group record now, so an
 * old address leads to its focus group's record with every parameter it knew; without any group to show, to the list.
 */
export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const params = new URL(c.req.url).searchParams;
  // An address with a valid focus needs no reading; only one without asks the service for its default.
  const direct = legacyRelationsHref(params, undefined);
  if (direct) return c.redirect(direct);
  const focus = await defaultRelationsFocus(user, c.req.raw.signal).catch(() => null);
  return c.redirect(legacyRelationsHref(params, focus) ?? GROUPS_PAGE_PATH);
});
