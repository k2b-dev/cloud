import { resolveDisplayNames } from "@k2b/cloud/server";
import { audit } from "@k2b/cloud/services";
import { principalLabel } from "@k2b/cloud/shared";
import { listMessages } from "../list-messages";
import { accountsMessages } from "../messages";
import type { AuditScreenProps } from "./AuditScreen";
import { actionLabel } from "./audit-labels";
import { AUDIT_PAGE_PATH, AUDIT_PER_PAGE, auditFilterOf, auditHref, auditQuery, parseAuditAddress } from "./query";
import { auditRows } from "./rows";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The audit log's part of the activity page: reads the address with its declaration, lists the events through the
 * audit service, and names the chosen identities. Returns the screen's data, or the address to go to instead.
 */
export const loadAudit = async (
  url: URL,
  context: { locale: string; timeZone: string; pendingRequests: number },
): Promise<{ redirect: string } | { props: AuditScreenProps }> => {
  const { locale, timeZone } = context;
  const { t } = accountsMessages.resolve([locale]);
  const query = auditQuery(locale);
  const address = parseAuditAddress(query, url.searchParams);
  const { state } = address;
  const eventsPage = await audit
    .list({ pagination: { page: address.page, perPage: AUDIT_PER_PAGE }, filter: auditFilterOf(state, address.automatic) })
    .catch(() => null);
  // A page past the end, from an old link or after a narrower filter, opens the last page with the same filters.
  const pages = Math.max(1, Math.ceil((eventsPage?.total ?? 0) / AUDIT_PER_PAGE));
  if (eventsPage && address.page > pages) return { redirect: auditHref(query, state, { page: pages, automatic: address.automatic }) };

  // Chosen identities are named even when no event on this page carries them; some writers record only the actor's
  // user ID, so those actors are named in the same batch.
  const { actor, target, serviceAccountId, action } = state.filters;
  const unnamed = [
    ...new Set((eventsPage?.items ?? []).flatMap((event) => (event.actor.userId && !event.actor.uid ? [event.actor.userId] : []))),
  ];
  const resolved = await resolveDisplayNames([
    ...[...new Set([...unnamed, ...(actor && UUID.test(actor) ? [actor] : []), ...(target && UUID.test(target) ? [target] : [])])].map(
      (userId) => ({ principal: { type: "user" as const, userId } }),
    ),
    ...(target && UUID.test(target) ? [{ principal: { type: "group" as const, groupId: target } }] : []),
    ...(serviceAccountId && UUID.test(serviceAccountId) ? [{ principal: { type: "service_account" as const, serviceAccountId } }] : []),
  ]);
  // Only an identity that still exists has a name; the rest keep the localized fallback.
  const named = resolved.filter((entry) => entry.displayName !== undefined);
  const nameOf = (value: string, kinds: readonly string[]): string | undefined => {
    const entry = named.find((candidate) => {
      const principal = candidate.principal;
      return (
        kinds.includes(principal.type) &&
        ((principal.type === "user" && principal.userId === value) ||
          (principal.type === "group" && principal.groupId === value) ||
          (principal.type === "service_account" && principal.serviceAccountId === value))
      );
    });
    return entry ? principalLabel(entry, locale) : undefined;
  };
  const fallback = (value: string, type: "user" | "service_account") =>
    UUID.test(value)
      ? principalLabel(
          type === "user"
            ? { principal: { type: "user", userId: value } }
            : { principal: { type: "service_account", serviceAccountId: value } },
          locale,
        )
      : value;
  // a target the page shows names itself the way its row does
  const targetRow = target
    ? eventsPage?.items.find((event) => event.target.id === target || event.target.label === target)?.target.label
    : undefined;
  const names = {
    actor: actor ? [{ value: actor, label: nameOf(actor, ["user"]) ?? fallback(actor, "user") }] : [],
    target: target ? [{ value: target, label: nameOf(target, ["user", "group"]) ?? targetRow ?? fallback(target, "user") }] : [],
    serviceAccountId: serviceAccountId
      ? [{ value: serviceAccountId, label: nameOf(serviceAccountId, ["service_account"]) ?? fallback(serviceAccountId, "service_account") }]
      : [],
    action: action ? [{ value: action, label: actionLabel(action, t) }] : [],
  };
  const rows = eventsPage
    ? auditRows(eventsPage.items, {
        t,
        locale,
        timeZone,
        names: named.flatMap((entry) =>
          entry.principal.type === "user" && entry.displayName !== undefined
            ? [{ userId: entry.principal.userId, name: entry.displayName }]
            : [],
        ),
      })
    : null;

  // Showing or hiding automatic app entries keeps every other part of the address and starts at the first page.
  const toggle = new URLSearchParams(url.searchParams);
  toggle.delete("page");
  if (address.automatic) toggle.delete("automatic");
  else toggle.set("automatic", "1");

  const words = listMessages.resolve([locale]).t;
  const ignored =
    address.issues.length > 0
      ? words.ignoredPartsDetail({
          params: address.issues.map((issue) => (issue.param ? `${issue.param}=${issue.value}` : issue.code)).join(", "),
        })
      : null;
  return {
    props: {
      state,
      page: address.page,
      pages,
      total: eventsPage?.total ?? 0,
      rows,
      names,
      automatic: {
        shown: address.automatic,
        hidden: eventsPage?.hiddenAutomaticCount ?? 0,
        href: toggle.size ? `${AUDIT_PAGE_PATH}?${toggle}` : AUDIT_PAGE_PATH,
      },
      ignored,
      pendingRequests: context.pendingRequests,
    },
  };
};
