import { describe, expect, spyOn, test } from "bun:test";
import { type AppRegistryEntry, CapabilityManifestSchema } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import * as registry from "../../../cloud/src/_internal/registry";
import {
  calendarEventSchema,
  calendarInvitationImportResultSchema,
  contactResolveMatchSchema,
  eventInvitationCommitDataSchema,
  spacesMailDestinationContextSchema,
} from "../app-integration-contracts";
import { getSpacesMailIntegrationAvailability, projectAppCapabilityError } from "./app-integrations";

const legacyUuid = "11111111-1111-4111-8111-111111111111";

describe("Mail contact-directory integration", () => {
  const match = {
    ref: { type: "contacts.contact", id: "Cont01" },
    contactId: "Cont01",
    bookId: "Book01",
    bookName: "Customers",
    displayName: "Ada Example",
    companyName: null,
    jobTitle: null,
    matchedEmails: ["ada@example.test"],
    emails: [{ label: "work", email: "ada@example.test" }],
    phones: [],
    contactPointsTruncated: false,
    updatedAt: "2026-08-11T08:00:00.000Z",
    openHref: "/app/contacts/Book01?contact=Cont01&contactBook=Book01",
  };

  test("keeps provider-owned contact IDs and links", () => {
    expect(contactResolveMatchSchema.safeParse(match).success).toBeTrue();
    expect(
      contactResolveMatchSchema.safeParse({
        ...match,
        ref: { type: "crm.customer", id: legacyUuid },
        contactId: legacyUuid,
        bookId: "customers",
        openHref: `/app/crm/customers/${legacyUuid}`,
      }).success,
    ).toBeTrue();
  });

  test("only exposes root-relative Cloud links", () => {
    expect(contactResolveMatchSchema.safeParse({ ...match, openHref: "https://crm.example.test/customers/1" }).success).toBeFalse();
    expect(contactResolveMatchSchema.safeParse({ ...match, openHref: "//crm.example.test/customers/1" }).success).toBeFalse();
    expect(contactResolveMatchSchema.safeParse({ ...match, openHref: null }).success).toBeTrue();
  });
});

describe("Mail Spaces integration resource IDs", () => {
  test("accepts short Space resource IDs and rejects UUIDs", () => {
    expect(
      spacesMailDestinationContextSchema.safeParse({
        selectedSpaceId: "space1",
        items: [{ id: "space1", name: "Roadmap", color: "#3b82f6" }],
      }).success,
    ).toBeTrue();
    expect(spacesMailDestinationContextSchema.safeParse({ selectedSpaceId: legacyUuid, items: [] }).success).toBeFalse();

    const event = {
      kind: "event",
      id: "event1",
      spaceId: "space1",
      columnId: "todo01",
      title: "Planning",
      location: null,
      startsAt: "2026-08-11T08:00:00.000Z",
      endsAt: "2026-08-11T09:00:00.000Z",
      allDay: false,
    };
    expect(calendarEventSchema.safeParse(event).success).toBeTrue();
    expect(calendarEventSchema.safeParse({ ...event, id: legacyUuid }).success).toBeFalse();
  });

  test("keeps only the technical delivery ID UUID-backed", () => {
    expect(
      calendarInvitationImportResultSchema.safeParse({
        itemId: "event1",
        spaceId: "space1",
        href: "/app/spaces/space1?item=event1",
        outcome: "created",
      }).success,
    ).toBeTrue();
    expect(
      calendarInvitationImportResultSchema.safeParse({
        itemId: "event1",
        spaceId: "space1",
        href: `/app/spaces/${legacyUuid}?item=${legacyUuid}`,
        outcome: "created",
      }).success,
    ).toBeFalse();
    expect(
      eventInvitationCommitDataSchema.safeParse({
        deliveryId: legacyUuid,
        itemId: "event1",
        draftId: "draft1",
        state: "drafted",
      }).success,
    ).toBeTrue();
    expect(
      eventInvitationCommitDataSchema.safeParse({
        deliveryId: "short1",
        itemId: legacyUuid,
        draftId: legacyUuid,
        state: "drafted",
      }).success,
    ).toBeFalse();
  });
});

describe("Mail app capability integration errors", () => {
  test("preserves an unknown action outcome without retrying or relabeling it", () => {
    expect(projectAppCapabilityError({ code: "ACTION_OUTCOME_UNKNOWN", message: "Outcome unknown", status: 502 })).toEqual({
      ok: false,
      code: "ACTION_OUTCOME_UNKNOWN",
      message: "Outcome unknown",
      status: 502,
    });
  });

  test("normalizes unavailable discovery status while preserving its exact code", () => {
    expect(projectAppCapabilityError({ code: "CAPABILITY_NOT_FOUND", message: "Missing", status: 404 })).toEqual({
      ok: false,
      code: "CAPABILITY_NOT_FOUND",
      message: "Missing",
      status: 503,
    });
  });
});

const authority: RequestAuthority = {
  actor: {
    kind: "service_account",
    serviceAccount: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Catalog reader",
      kind: "standalone",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    delegatedUser: null,
    scopes: ["read"],
  },
  accessSubject: { type: "service_account", serviceAccountId: "11111111-1111-4111-8111-111111111111" },
  credentialKind: "oauth",
  scopes: ["read"],
};

const manifest = CapabilityManifestSchema.parse(
  await Bun.file(new URL("../../../../tests/fixtures/capabilities/v2/spaces.json", import.meta.url)).json(),
);

test("mail integration discovery uses request authority and preserves credential caps", async () => {
  let app: AppRegistryEntry = {
    id: "spaces",
    name: "Spaces",
    icon: "ti ti-apps",
    description: "Catalog fixture",
    routes: [],
    baseUrl: "http://test.invalid",
    access: { kind: "signedIn" },
  };
  const spies = [
    spyOn(registry, "getApp").mockImplementation(async () => app),
    spyOn(registry, "getCapability").mockResolvedValue({
      appId: app.id,
      appName: app.name,
      appIcon: app.icon,
      appDescription: app.description,
      endpoint: "/api/spaces/capabilities",
      manifest,
    }),
  ];
  try {
    expect(await getSpacesMailIntegrationAvailability(authority)).toEqual({
      invitations: true,
      settings: true,
      composer: true,
      context: true,
    });
    expect(await getSpacesMailIntegrationAvailability(null)).toEqual({
      invitations: false,
      settings: false,
      composer: false,
      context: false,
    });
    // The actor is unchanged; only the actual credential scope narrows.
    expect(await getSpacesMailIntegrationAvailability({ ...authority, scopes: ["other:read"] })).toEqual({
      invitations: false,
      settings: false,
      composer: false,
      context: false,
    });
    app = { ...app, access: { kind: "roles", roles: ["admin"] } };
    expect(await getSpacesMailIntegrationAvailability(authority)).toEqual({
      invitations: false,
      settings: false,
      composer: false,
      context: false,
    });
    app = { ...app, access: undefined };
    expect(await getSpacesMailIntegrationAvailability(null)).toEqual({ invitations: true, settings: true, composer: true, context: true });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
