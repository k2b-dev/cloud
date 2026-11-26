import type { NotificationQuietSettings, ServiceAccountCredential, WebAuthnPasskey } from "@k2b/cloud/contracts";
import type { AccountUserView } from "./account-view";
import type { SecurityScreenProps } from "./SecurityScreen.island";

// Frozen, invented sample data for the account screens: dates are fixed, ids are fixed, nobody real.
export const NOW = "2026-11-24T10:00:00.000Z";
export const USER_ID = "00000000-0000-4000-8000-000000000042";

export const userView: AccountUserView = {
  name: "Jonas Beispiel",
  uid: "jbeispiel",
  image: undefined,
  kinds: ["FreeIPA", "Admin"],
};

export const passkeys: WebAuthnPasskey[] = [
  {
    id: "00000000-0000-4000-8000-000000000201",
    userId: USER_ID,
    name: "Arbeitslaptop",
    transports: ["internal"],
    deviceType: "multiDevice",
    backedUp: true,
    createdAt: "2026-09-01T08:00:00.000Z",
    lastUsedAt: "2026-11-24T08:00:00.000Z",
  },
];

export const apiKeys: ServiceAccountCredential[] = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    serviceAccountId: "00000000-0000-4000-8000-000000000102",
    name: "Laptop-Skripte",
    kind: "api_token",
    status: "active",
    tokenPrefix: "cld_7f3a",
    scopes: [],
    expiresAt: "2026-12-31T00:00:00.000Z",
    lastUsedAt: NOW,
    createdBy: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    revokedAt: null,
    revokedBy: null,
  } as ServiceAccountCredential,
];

export const securityProps = (): SecurityScreenProps => ({
  user: userView,
  userId: USER_ID,
  provider: "ipa",
  profile: "user",
  freeIpaEnabled: true,
  passkeys,
  devices: null,
  phones: null,
  apiKeys: {
    keys: apiKeys,
    openAiBaseUrl: "https://cloud.example.test/api/ai/openai/v1",
    mcpEndpoint: "https://cloud.example.test/api/mcp/v1",
    cloudUrl: "https://cloud.example.test",
    timeZone: "Europe/Berlin",
  },
  now: NOW,
});

/** Do not disturb with no pause and quiet hours on weekday nights, in Berlin. */
export const quietSettings: NotificationQuietSettings = {
  doNotDisturbUntil: null,
  quietHours: { timeZone: "Europe/Berlin", periods: [{ days: [1, 2, 3, 4, 5], start: "22:00", end: "07:00" }] },
  state: { active: false, reason: null, until: null, nextStart: null },
};
