/**
 * The faces of groups in Accounts. A group has no colour of its own, so it wears the colour of its type: a group, or a
 * personal Linux group that belongs to one user. The same mark stands in the list, the record's head, its rows, the
 * relations and the sentences of its activity.
 */
export const groupMark = { icon: "users-group", color: "#0e7490" } as const;
export const personalGroupMark = { icon: "user-circle", color: "#7c3aed" } as const;

/** The toned chips of what a group is: managed in FreeIPA, a POSIX group, a personal group. */
export const groupTags = {
  ipa: { icon: "building", color: "#b45309" },
  posix: { icon: "terminal-2", color: "#15803d" },
  personal: { icon: "user", color: personalGroupMark.color },
} as const;

export const markOf = (group: { personal?: boolean }) => (group.personal ? personalGroupMark : groupMark);
