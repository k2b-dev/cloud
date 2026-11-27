import type { OAuthClient } from "@/contracts";

/** The mark of each kind of client on the pages a person decides on: its symbol, neutral. */
export const KIND_MARKS = {
  first_party: { icon: "cloud" },
  managed: { icon: "key" },
  dynamic: { icon: "world" },
} as const;

/** The mark of a group a client is limited to, beside the faces of its people. */
export const GROUP_MARK = { icon: "users-group" } as const;

export type ClientKind = keyof typeof KIND_MARKS;

/** Soft data colours for the letters of clients; the same client always gets the same one. */
const LETTER_COLOURS = ["#4f46e5", "#0d9488", "#c2410c", "#7c3aed", "#be185d", "#0369a1", "#4d7c0f", "#b45309"];

/**
 * A client's mark in the admin list and its open record: Cloud's own client its cloud; every other one the first
 * letter of its name in a colour of its own, so a client is found again at a glance.
 */
export const clientMark = (client: Pick<OAuthClient, "name" | "clientId" | "registrationKind">) => {
  if (client.registrationKind === "first_party") return { icon: "cloud", color: "#111827" };
  const letter = client.name.normalize("NFD").toLowerCase().match(/[a-z]/)?.[0];
  const index = [...client.clientId].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7) % LETTER_COLOURS.length;
  return { icon: letter ? `letter-${letter}` : "key", color: LETTER_COLOURS[index] };
};
