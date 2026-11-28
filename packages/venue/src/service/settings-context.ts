import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import type { Venue } from "../contracts";
import { venueService } from "../service";
import { projectOpeningRules, projectOverrides, projectTemplates, projectVenues } from "./public-projection";
import { batchedPublicIds } from "./public-resources";

const VENUE_APP_ID = "venue";
const VENUE_RESOURCE_TYPE = "venue";

/**
 * The venue's active resource-bound API keys, each with the access its service account holds on the venue. A caller
 * that already read the venue's access passes it, so it is not read twice.
 */
export const listVenueApiKeys = async (
  venueId: string,
  known?: Awaited<ReturnType<typeof venueService.access.list>>,
): Promise<ResourceApiKey[]> => {
  const [keys, accessEntries] = await Promise.all([
    serviceAccountCredentials.listOverview({
      pagination: { page: 1, perPage: 500 },
      filter: {
        serviceAccountKind: "resource_bound",
        credentialStatus: "active",
        appId: VENUE_APP_ID,
        resourceType: VENUE_RESOURCE_TYPE,
        resourceId: venueId,
      },
    }),
    known ?? venueService.access.list(venueId),
  ]);
  const permissionByServiceAccountId = new Map(
    accessEntries.flatMap((entry) =>
      entry.principal.type === "service_account" ? [[entry.principal.serviceAccountId, entry.permission] as const] : [],
    ),
  );
  return keys.items.map((item) => {
    const permission = permissionByServiceAccountId.get(item.serviceAccount.id) ?? "none";
    const { serviceAccount: _serviceAccount, owner: _owner, ...credential } = item;
    return { ...credential, permission };
  });
};

/**
 * What the settings of one venue show, projected for the browser: the venue, its opening rules, exceptions and shift
 * templates, and for admins who has access and the API keys. The settings page and its API read the same.
 */
export const loadVenueSettingsContext = async (venue: Venue) => {
  const isAdmin = venue.permission === "admin";
  // who has access is read once: the access list shows it and the API keys name their permission from it
  const access = isAdmin ? venueService.access.list(venue.id, venue.permission) : Promise.resolve([]);
  const [openingRules, overrides, templates, accessEntries, apiKeys] = await Promise.all([
    venueService.openingRules.list(venue.id),
    venueService.overrides.list(venue.id),
    venueService.templates.list(venue.id),
    access,
    isAdmin ? access.then((entries) => listVenueApiKeys(venue.id, entries)) : Promise.resolve([]),
  ]);
  // the parts read their public ids together: one statement per table
  const lookup = batchedPublicIds();
  const [venues, projectedRules, projectedOverrides, projectedTemplates] = await Promise.all([
    projectVenues([venue], lookup),
    projectOpeningRules(openingRules, lookup),
    projectOverrides(overrides, lookup),
    projectTemplates(templates, lookup),
  ]);
  return {
    venue: venues[0]!,
    openingRules: projectedRules,
    overrides: projectedOverrides,
    templates: projectedTemplates,
    accessEntries,
    apiKeys,
  };
};
