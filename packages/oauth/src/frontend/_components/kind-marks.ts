/**
 * One mark per kind of client, the same in its open client and on the pages a person decides on. Neutral: colour is
 * kept for states that need a look and the one main action.
 */
export const KIND_MARKS = {
  first_party: { icon: "cloud" },
  managed: { icon: "key" },
  dynamic: { icon: "world" },
} as const;

/** The mark of a group a client is limited to, beside the faces of its people. */
export const GROUP_MARK = { icon: "users-group" } as const;

export type ClientKind = keyof typeof KIND_MARKS;
