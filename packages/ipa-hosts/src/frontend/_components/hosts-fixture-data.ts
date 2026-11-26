import type { IpaHost, IpaHostgroup } from "@/contracts";

// Invented hosts of a workshop's network for tests and pictures: no production data. Dense on purpose: 18 groups and
// about 40 hosts, as a real mirror holds, so a list is never half empty.

export const fixtureHost = (fqdn: string, extra: Partial<IpaHost> = {}): IpaHost => ({
  fqdn,
  description: null,
  location: null,
  locality: null,
  memberofHostgroup: [],
  macAddress: [],
  platform: null,
  osVersion: null,
  sshFingerprints: [],
  ...extra,
});

const GROUPS: [cn: string, description: string | null, hosts: string[], nested: string[]][] = [
  ["server", "Server im Rechenraum", ["db1", "db2", "app1", "app2", "backup"], ["monitoring"]],
  ["arbeitsplaetze", "PCs in Büro und Werkstatt", ["pc-01", "pc-02", "pc-03", "pc-04", "pc-05"], []],
  ["laptops", "Mobile Geräte der Bauleitung", ["nb-mueller", "nb-yilmaz", "nb-schmidt"], []],
  ["drucker", "Drucker und Scanner", ["drucker-buero", "plotter-cad"], []],
  ["werkstatt-terminals", "Bedienterminals an den Maschinen", ["term-cnc-1", "term-cnc-2", "term-saege"], ["maschinen"]],
  ["maschinen", "Steuerrechner der Maschinen", ["cnc-1", "cnc-2"], []],
  ["monitoring", "Überwachung und Protokolle", ["grafana", "loki"], []],
  ["netzwerk", "Router, Switches und WLAN", ["router", "switch-eg", "switch-og", "ap-halle"], []],
  ["telefonie", "Telefonanlage", ["pbx"], []],
  ["kameras", null, ["cam-tor", "cam-lager"], []],
  ["lager", "Scanner und Etikettendrucker im Lager", ["scanner-lager", "etiketten-1"], []],
  ["entwicklung", "Test- und Bausysteme", ["build-1", "staging"], ["server"]],
  ["buchhaltung", "Zugriff auf die Finanzbuchhaltung", ["pc-04"], []],
  ["leitung", null, ["nb-mueller", "pc-01"], ["laptops", "arbeitsplaetze"]],
  ["empfang", "Gäste-PC und Infobildschirm", ["infoscreen"], []],
  ["schulung", "Schulungsraum", ["schulung-1", "schulung-2"], []],
  ["archiv", "Außer Betrieb, nur noch lesend", [], []],
  ["vpn", "Außenstellen über VPN", ["filiale-sued"], ["netzwerk"]],
];

const OS = ["Debian 13", "Ubuntu 24.04", "Fedora 43", "Windows 11", "RouterOS 7"];

const detail = (name: string, index: number, groups: string[]): IpaHost =>
  fixtureHost(`${name}.werkstatt.example`, {
    description: index % 4 === 0 ? ["Hauptsystem", "Ersatzgerät", "Leihgerät", "Prüfplatz"][index % 4]! : null,
    locality: ["Halle 2", "Büro OG", "Lager", "Rechenraum"][index % 4]!,
    location: index % 3 === 0 ? `Platz ${index + 1}` : null,
    memberofHostgroup: groups,
    macAddress:
      index % 5 === 4
        ? []
        : [
            `AA:BB:CC:00:${String(index).padStart(2, "0")}:01`,
            ...(index % 7 === 0 ? [`AA:BB:CC:00:${String(index).padStart(2, "0")}:02`] : []),
          ],
    platform: "x86_64",
    osVersion: OS[index % OS.length]!,
    sshFingerprints:
      index % 6 === 5
        ? []
        : [`SHA256:${index.toString(16).padStart(4, "0")}Kx9eM0vXr1q3Q2s1u8u0b3Jt2r4Wl0oYc root@${name}.werkstatt.example (ssh-ed25519)`],
  });

/** The 18 groups with their hosts, each host knowing every group it is in. */
export const denseGroups = (): (IpaHostgroup & { hostDetails: IpaHost[] })[] => {
  const names = [...new Set(GROUPS.flatMap(([, , hosts]) => hosts))];
  const memberOf = (name: string) => GROUPS.filter(([, , hosts]) => hosts.includes(name)).map(([cn]) => cn);
  return GROUPS.map(([cn, description, hosts, nested]) => ({
    cn,
    description,
    hosts: hosts.map((name) => `${name}.werkstatt.example`),
    hostgroups: nested,
    hostDetails: hosts.map((name) => detail(name, names.indexOf(name), memberOf(name))),
  }));
};

/** An invented ED25519 fingerprint as FreeIPA writes it. */
const key = (seed: string) => `SHA256:${seed}Kx9eM0vXr1q3Q2s1u8u0b3Jt2r4Wl0oYcQ7Z (ssh-ed25519)`;

/** Hosts the mirror holds without a group: newly enrolled, half described; one still has no key. */
export const denseUngrouped = (): IpaHost[] => [
  fixtureHost("neu-01.werkstatt.example", { locality: "Lager", osVersion: "Debian 13", sshFingerprints: [key("0901")] }),
  fixtureHost("laptop-azubi.werkstatt.example", { macAddress: ["AA:BB:CC:00:99:01"], sshFingerprints: [key("0902")] }),
  fixtureHost("tablet-montage.werkstatt.example", { description: "Montage-Tablet", sshFingerprints: [] }),
  fixtureHost("pi-wetterstation.werkstatt.example", {
    locality: "Dach",
    platform: "aarch64",
    osVersion: "Raspberry Pi OS",
    sshFingerprints: [key("0904")],
  }),
];

export const LONG_HOST = "kunden-und-auftraege-werkstatt-nord-zeiterfassung-und-materialbestellung-01.intern.werkstatt-nord.example";
export const LONG_GROUP = "werkstatt-nord-schichtbetrieb-maschinen-und-messplaetze-im-erdgeschoss";

/**
 * The worst a mirror holds, a whole page of it: 100 groups with long names and descriptions, nested groups, a host with
 * a very long name, mixed scripts, six MAC addresses and eight groups, and groups without hosts or description.
 */
export const worstGroups = (): (IpaHostgroup & { hostDetails: IpaHost[] })[] => {
  const longHost = fixtureHost(LONG_HOST, {
    description: "Терминал · 工作站 · محطة عمل 🖥️",
    locality: "Werkstatt Nord, Erdgeschoss, Halle 7 (Anbau)",
    location: "Rack 12, Höheneinheit 38–40",
    memberofHostgroup: [LONG_GROUP, ...Array.from({ length: 7 }, (_, index) => `gruppe-${index + 1}`)],
    macAddress: Array.from({ length: 6 }, (_, index) => `AA:BB:CC:DD:EE:0${index}`),
    osVersion: "Debian 13",
    sshFingerprints: Array.from(
      { length: 3 },
      (_, index) => `SHA256:${"x".repeat(43)}${index} schichtleitung-werkstatt-nord@kunden-und-auftraege.example (ssh-rsa)`,
    ),
  });
  return [
    {
      cn: LONG_GROUP,
      description: "Alle Maschinen, Messplätze und Bedienterminals der Werkstatt Nord im Erdgeschoss, die im Schichtbetrieb laufen",
      hosts: [LONG_HOST],
      hostgroups: Array.from({ length: 6 }, (_, index) => `untergruppe-mit-langem-namen-${index + 1}`),
      hostDetails: [longHost],
    },
    { cn: "x", description: null, hosts: [], hostgroups: [], hostDetails: [] },
    ...Array.from({ length: 98 }, (_, index) => {
      const cn = `standort-${String(index + 1).padStart(3, "0")}-${["lager", "buero", "halle", "aussenstelle-sued"][index % 4]}`;
      const hosts = Array.from({ length: index % 5 }, (_, at) =>
        fixtureHost(`${cn}-${at + 1}.werkstatt.example`, { memberofHostgroup: [cn], osVersion: OS[at % OS.length]! }),
      );
      return {
        cn,
        description: index % 3 ? `Geräte am Standort ${index + 1}` : null,
        hosts: hosts.map((host) => host.fqdn),
        hostgroups: index % 9 === 0 ? ["netzwerk"] : [],
        hostDetails: hosts,
      };
    }),
  ];
};

export const worstUngrouped = (): IpaHost[] => [
  fixtureHost("a"),
  fixtureHost(LONG_HOST.replace("01", "02"), { macAddress: ["AA:BB:CC:DD:EE:FF", "AA:BB:CC:DD:EE:F1"] }),
  ...Array.from({ length: 40 }, (_, index) =>
    fixtureHost(`neu-${String(index + 1).padStart(3, "0")}.werkstatt.example`, { locality: index % 2 ? "Lager" : null }),
  ),
];
