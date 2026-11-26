/**
 * The kinds of things on the account pages, each with one symbol and one colour, so a passkey, a device or a key looks
 * the same in a figure, a row and a sentence (`Mark`).
 */
export const ACCOUNT_KINDS = {
  passkey: { icon: "fingerprint", color: "#0d9488" },
  device: { icon: "device-mobile-check", color: "#2563eb" },
  phone: { icon: "device-mobile", color: "#0284c7" },
  apiKey: { icon: "key", color: "#7c3aed" },
  modelsKey: { icon: "sparkles", color: "#c026d3" },
  group: { icon: "users", color: "#16a34a" },
  inheritedGroup: { icon: "git-branch", color: "#65a30d" },
  managedGroup: { icon: "user-shield", color: "#d97706" },
  password: { icon: "lock", color: "#0891b2" },
  session: { icon: "logout", color: "#4f46e5" },
  deletion: { icon: "trash", color: "#e11d48" },
  freeIpa: { icon: "building-fortress", color: "#9333ea" },
  profile: { icon: "user", color: "#0284c7" },
} as const;

/** A passkey's ways to reach the browser (WebAuthn transports) in words, such as "USB-Schlüssel". */
export const transportWords = (
  transports: readonly string[],
  t: {
    transportInternal: string;
    transportHybrid: string;
    transportUsb: string;
    transportNfc: string;
    transportBle: string;
    transportSmartCard: string;
  },
): string[] =>
  transports.flatMap((transport) => {
    const words = {
      internal: t.transportInternal,
      hybrid: t.transportHybrid,
      usb: t.transportUsb,
      nfc: t.transportNfc,
      ble: t.transportBle,
      "smart-card": t.transportSmartCard,
    }[transport];
    return words ? [words] : [];
  });
