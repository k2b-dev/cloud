/** Invented chats for render tests and previews, after the approved mockup of 15.10.2026. */
const people = {
  mia: { type: "user" as const, id: "11111111-1111-4111-8111-111111111111", name: "Mia Berger" },
  jana: { type: "user" as const, id: "22222222-2222-4222-8222-222222222222", name: "Jana Schmidt" },
  paul: { type: "user" as const, id: "33333333-3333-4333-8333-333333333333", name: "Paul Richter" },
  nora: { type: "user" as const, id: "44444444-4444-4444-8444-444444444444", name: "Nora Weber" },
};
const at = (h: number, m: number, day = 15) => new Date(Date.UTC(2026, 9, day, h - 2, m)).toISOString();
const conv = (
  id: string,
  title: string,
  members: number,
  unread: number,
  last: { author: keyof typeof people; text: string; at: string } | null,
) => ({
  unread,
  read: { lastReadSeq: 1, unreadFromSeq: unread ? 2 : null, joinedSeq: 0 },
  id,
  name: members > 2 ? title : null,
  icon: null,
  purpose: null,
  title,
  memberCount: members,
  withGuests: false,
  peerDeactivated: false,
  rev: 3,
  permission: "write" as const,
  createdAt: at(8, 0, 1),
  lastActivityAt: last?.at ?? at(8, 0, 1),
  lastMessage: last ? { id: `${id}0001`, author: people[last.author], preview: last.text, createdAt: last.at } : null,
});
export const conversations = [
  conv("Werk01", "Werkstatt-Team", 4, 3, { author: "jana", text: "Die Ersatzteile sind bestellt 👍", at: at(14, 32) }),
  conv("Mobi01", "Mobile App", 5, 2, { author: "paul", text: "Bitte einmal auf dem iPad im Querformat prüfen.", at: at(11, 20) }),
  conv("Nora01", "Nora Weber", 2, 0, { author: "mia", text: "Passt, bis nachher!", at: at(10, 5) }),
  conv("Jana01", "Jana Schmidt", 2, 0, { author: "jana", text: "Danke dir!", at: at(16, 52, 14) }),
];
const msg = (conversationId: string, seq: number, author: keyof typeof people, body: string, time: string) => ({
  id: `${conversationId}${String(seq).padStart(4, "0")}`,
  conversationId,
  seq,
  rev: seq,
  kind: "text" as const,
  author: people[author],
  body,
  system: null,
  createdAt: time,
  systemText: null,
});
const log = [
  msg("Werk01", 1, "paul", "Moin! Der Kompressor macht wieder Geräusche.", at(9, 12)),
  msg("Werk01", 2, "mia", "Ich schau ihn mir heute Nachmittag an.", at(9, 15)),
  msg("Werk01", 3, "jana", "Brauchen wir dafür neue Dichtungen?", at(10, 2)),
  msg("Werk01", 4, "mia", "Wahrscheinlich. Ich setze sie auf die Liste „Ersatzteile bestellen“.", at(10, 5)),
  msg("Werk01", 5, "jana", "Hab gerade beim Händler angerufen.", at(14, 28)),
  msg("Werk01", 6, "jana", "Dichtungen und Luftfilter sind da, Lieferung am Montag.", at(14, 30)),
  msg("Werk01", 7, "jana", "Die Ersatzteile sind bestellt 👍", at(14, 32)),
];
export const chatView = (conversationId?: string) => ({
  cursor: "0",
  sidebar: { items: conversations, nextCursor: null },
  open:
    conversationId === "Werk01"
      ? { conversation: { ...conversations[0]!, unread: 0 }, page: { items: log, seqHead: 7, rev: 7 }, focus: null }
      : null,
});
