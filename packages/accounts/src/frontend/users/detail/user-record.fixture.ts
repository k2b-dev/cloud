import type { User } from "@/contracts";
import { agentKeys, worstKeys } from "../../service-accounts/keys-and-new-user.fixture";
import type { LinuxSnapshot, UserGroupView, UserRecordView } from "./user-view";

// Invented records for the browser test: a usual local account, the worst case a real directory produces (long and
// unbreakable names, non-Latin text, many groups, an expired FreeIPA account, devices that could not be loaded) and an
// empty one. Dates come formatted, as the server formats them.

export const USER_ID = "22222222-2222-4222-8222-222222222222";
export const GROUP_ID = (index: number) => `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`;
export const DEVICE_ID = (index: number) => `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`;
export const PHONE_ID = (index: number) => `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`;

export type FixtureName = "sample" | "worst" | "empty" | "optional-email" | "huge";

const base: User = {
  id: USER_ID,
  uid: "milan.horvat",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Milan",
  sn: "Horvat",
  displayName: "Milan Horvat",
  mail: "milan.horvat@solberg-kramer.example",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: "2026-11-20T08:00:00.000Z",
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};

const linux = (user: Pick<User, "id" | "uid" | "displayName" | "provider" | "profile">): LinuxSnapshot => ({
  config: { enabled: true, rangeStart: 200000, rangeEnd: 200999, homeTemplate: "/home/{username}", loginShell: "/bin/bash" },
  user: {
    id: user.id,
    uid: user.uid,
    displayName: user.displayName,
    provider: user.provider,
    profile: user.profile,
    identity: {
      userId: user.id,
      uidNumber: 200010,
      primaryGidNumber: 200010,
      homeDirectory: `/home/${user.uid}`,
      loginShell: "/bin/bash",
      managedBy: user.provider,
    },
    state: "ready",
  },
});

const group = (
  index: number,
  name: string,
  description: string | null,
  direct = true,
  provider: "local" | "ipa" = "local",
): UserGroupView => ({
  id: GROUP_ID(index),
  name,
  description,
  provider,
  direct,
});

const sample = (): UserRecordView => {
  const memberships = [
    group(1, "Verkauf", "Ankauf und Verkauf im Laden und online"),
    group(2, "Büro", null),
    group(5, "Lager", "Wareneingang, Lagerorte und Versand"),
    group(6, "Auktionen", "Einlieferungen, Kataloge und Zuschläge", true, "ipa"),
    group(7, "Fotostudio", "Bilder für Katalog und Shop"),
    group(8, "Kasse Laden Nord", "Tagesabschluss und Wechselgeld"),
    group(9, "Werkstatt", "Restaurierung von Möbeln und Uhren", true, "ipa"),
    group(3, "Alle Mitarbeitenden", "Jede Person mit Vollkonto", false),
    group(10, "Standort Berlin", "Alle am Standort Berlin", false, "ipa"),
  ];
  return {
    user: base,
    title: base.displayName,
    image: undefined,
    kinds: ["Login"],
    expired: false,
    status: "active",
    lastSignIn: "20.11.2026, 08:00",
    activity: [
      { actor: "Ada Admin", action: "hat das Konto bearbeitet", when: "Heute, 09:42" },
      { actor: "Jana Berger", action: "hat ein Mitglied hinzugefügt", when: "Gestern, 16:40" },
      { actor: "Ada Admin", action: "hat ein Anmeldetoken erstellt", when: "18. Nov. 2026, 11:05" },
      { actor: "Milan Horvat", action: "hat ein Gerät gekoppelt", when: "12. Sept. 2026, 10:00" },
      { actor: "Ada Admin", action: "hat das Konto erstellt", when: "1. Sept. 2026, 08:30" },
    ],
    expires: "31.03.2027",
    facts: [
      { label: "UID", value: base.uid, mono: true, copy: true },
      { label: "Datenbank-ID", value: base.id, mono: true, copy: true },
      { label: "Kontotyp", value: "Login" },
      { label: "Zugang", value: "Vollkonto" },
      { label: "E-Mail", value: base.mail ?? "", copy: true },
      { label: "Konto läuft ab", value: "Nie", missing: true },
      { label: "Letzte Web-Anmeldung", value: "20.11.2026" },
    ],
    sshFingerprints: [],
    linux: linux(base),
    memberships,
    directCount: 7,
    allCount: 9,
    managed: [group(4, "Aushilfen", "Wochenendkräfte im Laden"), group(11, "Praktikum", "Praktikantinnen und Praktikanten")],
    memberGroupIds: memberships.map((entry) => entry.id),
    keys: { keys: agentKeys, total: agentKeys.length, page: 1 },
    modelsAvailable: true,
    timeZone: "Europe/Berlin",
    signInDevices: [
      { id: DEVICE_ID(1), name: "Pixel 8", assisted: true, paired: "01.09.2026, 10:00", lastUsed: null },
      { id: DEVICE_ID(2), name: "Galaxy S24", assisted: false, paired: "03.10.2026, 12:15", lastUsed: "24.11.2026, 07:58" },
    ],
    appDevices: [
      { id: PHONE_ID(1), name: "iPhone im Laden", platform: "ios", paired: "12.09.2026, 10:00", lastUsed: "23.11.2026, 08:00" },
      { id: PHONE_ID(4), name: "iPad Werkstatt", platform: "ios", paired: "02.10.2026, 09:00", lastUsed: "25.11.2026, 17:20" },
    ],
    signInPairHref: `/me/security/pair?userId=${base.id}`,
    cloudApp: { blocked: false, administrator: "Ada Admin", cloud: "Solberg Cloud", name: base.displayName },
    freeIpaEnabled: true,
    localEmailOptional: false,
  };
};

const LONG_NAME = "Aleksandra Wiśniewska-Kowalczyk von Hohenzollern-Sigmaringen";
const LONG_MAIL = "bartholomew.fitzgerald@northwind-industries-holdings.example.com";
const NAMES = [
  "Geschäftsführung und Gesellschafterversammlung der Solberg & Kramer Antiquitäten GmbH",
  "日本語チーム",
  "Ελληνικό τμήμα πωλήσεων",
  "فريق المبيعات",
  "Lager",
  "x",
  "werkstatt-restaurierung-moebel-und-uhren-nord-sued-ost-west",
];

const worst = (): UserRecordView => {
  const user: User = {
    ...base,
    uid: "aleksandra.wisniewska-kowalczy",
    provider: "ipa",
    roles: ["user", "admin"],
    givenname: "Aleksandra",
    sn: "Wiśniewska-Kowalczyk von Hohenzollern-Sigmaringen",
    displayName: LONG_NAME,
    mail: LONG_MAIL,
    accountExpires: "2026-10-31T00:00:00.000Z",
    ipa: {
      uidNumber: 1284000017,
      phone: "+49 30 5550 1420",
      employeeType: "Restauratorin für Möbel, Uhren und mechanische Musikinstrumente",
      mobile: "+49 151 5550 98765",
      address: { street: "Hinter dem Alten Zeughaus 117a", postalCode: "10178", city: "Berlin-Mitte", state: "Berlin" },
      passwordExpires: null,
      lastLoginIpa: null,
      syncedAt: null,
      sshPublicKeys: ["ssh-ed25519 AAAA", "ssh-rsa AAAA"],
      sshFingerprints: [
        "SHA256:Qm9vbGVhbkZpbmdlcnByaW50T2ZBVmVyeUxvbmdLZXlUaGF0TmV2ZXJFbmRz aleksandra@werkstatt-laptop.solberg-kramer.example (ED25519)",
        "SHA256:c2Vjb25kRmluZ2VycHJpbnQ (RSA)",
      ],
    },
  };
  const memberships = Array.from({ length: 64 }, (_, index) =>
    group(
      100 + index,
      `${NAMES[index % NAMES.length]}${index >= NAMES.length ? ` ${index}` : ""}`,
      index % 3 === 0 ? null : `Beschreibung ${index}: ${LONG_MAIL}`,
      index % 5 !== 4,
      index % 2 ? "ipa" : "local",
    ),
  );
  return {
    ...sample(),
    user,
    title: LONG_NAME,
    kinds: ["FreeIPA", "Admin", "Gruppenverwaltung"],
    expired: true,
    status: "expired",
    lastSignIn: null,
    activity: null,
    expires: "31.10.2026",
    facts: [
      { label: "UID", value: user.uid, mono: true, copy: true },
      { label: "Datenbank-ID", value: user.id, mono: true, copy: true },
      { label: "Kontotyp", value: "FreeIPA" },
      { label: "Zugang", value: "Vollkonto" },
      { label: "E-Mail", value: LONG_MAIL, copy: true },
      { label: "Passwort läuft ab", value: "Nie", missing: true },
      { label: "Konto läuft ab", value: "31.10.2026 (abgelaufen)", overdue: true },
      { label: "Letzte Web-Anmeldung", value: "Nie", missing: true },
      { label: "Letzte Kerberos-Anmeldung", value: "Nie oder nicht erfasst", missing: true },
      { label: "Rolle", value: user.ipa?.employeeType ?? "" },
      { label: "Mobil", value: "+49 151 5550 98765" },
      { label: "Adresse", value: "Hinter dem Alten Zeughaus 117a, 10178 Berlin-Mitte, Berlin" },
    ],
    sshFingerprints: user.ipa?.sshFingerprints ?? [],
    linux: { ...linux(user), user: { ...linux(user).user, state: "identity_conflict" } },
    memberships,
    directCount: memberships.filter((entry) => entry.direct).length,
    allCount: memberships.length,
    managed: memberships.slice(0, 3).map((entry) => ({ ...entry, direct: false })),
    memberGroupIds: memberships.map((entry) => entry.id),
    keys: { keys: worstKeys, total: 1284, page: 1 },
    signInDevices: null,
    appDevices: [
      {
        id: PHONE_ID(2),
        name: "📱 Olas iPhone 15 Pro Max (Arbeit, Werkstatt Nord, 2. Etage)",
        platform: "ios",
        paired: "12.09.2026, 10:00",
        lastUsed: "23.11.2026, 08:00",
      },
      { id: PHONE_ID(3), name: "Tab", platform: "other", paired: "12.09.2026, 10:00", lastUsed: "23.11.2026, 08:00" },
    ],
    signInPairHref: null,
    cloudApp: { blocked: true, administrator: "Jo", cloud: "Solberg & Kramer Antiquitäten Cloud", name: LONG_NAME },
  };
};

const empty = (): UserRecordView => ({
  ...sample(),
  user: { ...base, mail: null, profile: "guest" },
  title: "milan.horvat",
  kinds: ["Gast"],
  linux: null,
  memberships: [],
  directCount: 0,
  allCount: 0,
  managed: [],
  memberGroupIds: [],
  keys: { keys: [], total: 0, page: 1 },
  signInDevices: [],
  appDevices: [],
  status: "invited",
  lastSignIn: null,
  activity: [],
  expires: null,
});

/** A person in 1,200 groups who manages 1,000: the record must stay light and quick. */
const huge = (): UserRecordView => {
  const memberships = Array.from({ length: 1200 }, (_, index) =>
    group(1000 + index, `Projekt ${index + 1}`, index % 2 ? `Arbeitsgruppe ${index + 1}` : null),
  );
  return {
    ...sample(),
    memberships,
    directCount: memberships.length,
    allCount: memberships.length,
    managed: memberships.slice(0, 1000).map((entry) => ({ ...entry, direct: false })),
    memberGroupIds: memberships.map((entry) => entry.id),
  };
};

export const fixtureRecord = (name: FixtureName): UserRecordView =>
  name === "huge"
    ? huge()
    : name === "worst"
      ? worst()
      : name === "empty"
        ? empty()
        : name === "optional-email"
          ? { ...sample(), localEmailOptional: true }
          : sample();
