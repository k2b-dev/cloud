// Invented sample data for the browser test of the API key sections, the API key list and the new-user page. Dates are
// formatted text as the server sends them; ids are fixed.
import { DEFAULT_ACCOUNT_CATEGORY_POLICY } from "@k2b/cloud/contracts";
import type { AccountRequestView } from "../users/new/create-user";
import type { AccountKey, ApiKeyRow } from "./api-key-row";
import type { DirectoryPage } from "./DirectoryAccessSection";

export const AGENT_ID = "5a1b0000-0000-4000-8000-000000000001";
export const OTHER_AGENT_ID = "5a1b0000-0000-4000-8000-000000000002";
export const PERSON_ID = "7c2d0000-0000-4000-8000-000000000001";
export const KEY_IDS = [
  "4e3f0000-0000-4000-8000-000000000001",
  "4e3f0000-0000-4000-8000-000000000002",
  "4e3f0000-0000-4000-8000-000000000003",
] as const;
export const TOKEN = "cld_9f8e_fiktiver-schluessel-nur-fuer-diesen-test-0011223344";

export const agentAccount = { id: AGENT_ID, name: "Wochenbericht", kind: "agent" as const, active: true };

export const agentKeys: AccountKey[] = [
  {
    id: KEY_IDS[0],
    name: "Laptop Jana",
    prefix: "cld_7f3a_…",
    active: true,
    access: null,
    created: "22.09.2026, 09:20",
    lastUsed: "24.11.2026, 18:02",
    expires: null,
    expired: false,
  },
  {
    id: KEY_IDS[1],
    name: "Alter Export-Job",
    prefix: "cld_0b52_…",
    active: true,
    access: "legacy",
    created: "02.03.2026, 08:00",
    lastUsed: null,
    expires: null,
    expired: false,
    replace: { serviceAccountId: AGENT_ID },
  },
  {
    id: KEY_IDS[2],
    name: "MCP-Server Team Ops",
    prefix: "cld_91c0_…",
    active: true,
    access: "models",
    created: "03.11.2026, 14:41",
    lastUsed: null,
    expires: "01.11.2026, 00:00",
    expired: true,
  },
];

/** Worst case for the section: long, unbreakable names and many keys. */
export const worstKeys: AccountKey[] = Array.from({ length: 14 }, (_, index) => ({
  id: `4e3f0000-0000-4000-8000-1000000000${String(index).padStart(2, "0")}`,
  name:
    index === 0
      ? "Nachtlauf-Synchronisation-der-Lagerbestaende-mit-dem-Warenwirtschaftssystem-und-dem-Onlineshop-ohne-Leerzeichen"
      : index === 1
        ? "東京オフィスの在庫同期キー 🔑"
        : `Schlüssel ${index + 1}`,
  prefix: `cld_${(index * 7919).toString(16).padStart(4, "0").slice(0, 4)}_…`,
  active: true,
  access: index % 3 === 0 ? "models" : index % 3 === 1 ? "legacy" : null,
  created: "01.01.2026, 00:00",
  lastUsed: index % 2 ? "31.12.2026, 23:59" : null,
  expires: index === 4 ? "02.01.2026, 00:00" : null,
  expired: index === 4,
  ...(index % 3 === 1 ? { replace: { serviceAccountId: AGENT_ID } } : {}),
}));

/** Huge case: an agent with 1,284 keys, which the API pages 50 at a time. */
export const HUGE_TOTAL = 1284;

/** One page of the huge agent's keys as the service's overview items, as the record's server and the API read them. */
export const hugeSources = (page: number, perPage: number) =>
  Array.from({ length: Math.max(0, Math.min(perPage, HUGE_TOTAL - (page - 1) * perPage)) }, (_, offset) => {
    const index = (page - 1) * perPage + offset;
    return {
      id: `4e3f0000-0000-4000-8000-2${String(index).padStart(11, "0")}`,
      name: index === 0 ? `Gerät 1 ${"mit-sehr-langem-namen-".repeat(5)}Ende` : `Gerät ${index + 1}`,
      status: index % 7 === 6 ? ("revoked" as const) : ("active" as const),
      tokenPrefix: index.toString(16).padStart(4, "0"),
      scopes: index % 10 === 0 ? ["ai:inference"] : ["read", "write", "admin"],
      expiresAt: null,
      lastUsedAt: index % 3 ? "2026-11-20T07:00:00.000Z" : null,
      createdAt: "2026-01-01T00:00:00.000Z",
      serviceAccount: { id: AGENT_ID, kind: "agent" },
    };
  });

export const directoryPage: DirectoryPage = {
  items: [
    {
      id: "6d000000-0000-4000-8000-000000000001",
      label: "Jana Berger",
      serviceAccountKind: null,
      principal: { type: "user", userId: PERSON_ID },
    },
    {
      id: "6d000000-0000-4000-8000-000000000002",
      label: "Lager",
      serviceAccountKind: null,
      principal: { type: "group", groupId: "6e000000-0000-4000-8000-000000000001" },
    },
  ],
  total: 2,
  page: 1,
  perPage: 20,
};

const row = (key: AccountKey, patch: Partial<ApiKeyRow>): ApiKeyRow => ({
  ...key,
  kind: "agent",
  owner: { kind: "agent", name: "Wochenbericht", href: `/app/accounts/agents/${AGENT_ID}` },
  ...patch,
});

export const listRows: ApiKeyRow[] = [
  row(agentKeys[0]!, {}),
  row(agentKeys[1]!, {}),
  row(
    { ...agentKeys[2]!, id: "4e3f0000-0000-4000-8000-000000000009", name: "Persönlicher CLI-Schlüssel", expired: false, expires: null },
    {
      kind: "user_delegated",
      owner: { kind: "user", name: "Jana Berger", detail: "jana.berger@kramer-lager.example", href: `/app/accounts/users/${PERSON_ID}` },
    },
  ),
  row(
    { ...agentKeys[0]!, id: "4e3f0000-0000-4000-8000-000000000010", name: "Postfach Einkauf", lastUsed: null },
    { kind: "resource_bound", owner: { kind: "resource", name: "mail", detail: "mailbox · einkauf" } },
  ),
];

export const worstListRows: ApiKeyRow[] = worstKeys.map((key, index) =>
  row(key, {
    owner:
      index === 0
        ? {
            kind: "user",
            name: "Maximiliane Alexandra von Hohenzollern-Sigmaringen-Wittelsbach",
            detail: "maximiliane.alexandra.von.hohenzollern-sigmaringen@sehr-lange-domain-ohne-ende.example",
            href: `/app/accounts/users/${PERSON_ID}`,
          }
        : { kind: "agent", name: "Wochenbericht", href: `/app/accounts/agents/${AGENT_ID}` },
  }),
);

export const policy = DEFAULT_ACCOUNT_CATEGORY_POLICY;

export const accountRequest: AccountRequestView = {
  id: "8a000000-0000-4000-8000-000000000001",
  email: "ida.berg@kramer-lager.example",
  firstName: "Ida",
  lastName: "Berg",
  displayName: null,
  phone: "+49 761 123456",
  comment: "Ich fange am 1. Dezember im Lager an.",
};
