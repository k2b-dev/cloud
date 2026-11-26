import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import type { Venue } from "../contracts";
import { venueService } from "../service";

const VENUE_APP_ID = "venue";
const VENUE_RESOURCE_TYPE = "venue";

/** The venue's active resource-bound API keys, each with the access its service account holds on the venue. */
export const listVenueApiKeys = async (venueId: string): Promise<ResourceApiKey[]> => {
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
    venueService.access.list(venueId),
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
  const [openingRules, overrides, templates, accessEntries, apiKeys] = await Promise.all([
    venueService.openingRules.list(venue.id),
    venueService.overrides.list(venue.id),
    venueService.templates.list(venue.id),
    isAdmin ? venueService.access.list(venue.id, venue.permission) : Promise.resolve([]),
    isAdmin ? listVenueApiKeys(venue.id) : Promise.resolve([]),
  ]);
  return {
    venue: (await venueService.publicResources.projectVenues([venue]))[0]!,
    openingRules: await venueService.publicResources.projectOpeningRules(openingRules),
    overrides: await venueService.publicResources.projectOverrides(overrides),
    templates: await venueService.publicResources.projectTemplates(templates),
    accessEntries,
    apiKeys,
  };
};
