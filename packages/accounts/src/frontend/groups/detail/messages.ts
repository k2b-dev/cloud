import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";

/** The words of a group's page on v2 that the shared Accounts catalog does not have. */
export const groupDetailMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      details: "Details",
      searchManagers: "Search managers…",
      show: "Show",
      indirectMembers: "Indirect members",
      agentMemberships: "Agents",
      clearSearch: "Clear search",
      addMembersTitle: "Add members",
      addManagersTitle: "Add managers",
      addToGroupsTitle: "Add this group to groups",
      lookupPeople: ({ groups, agents }: { groups: boolean; agents: boolean }): string =>
        groups && agents ? "Users, groups and agents" : groups ? "Users and groups" : agents ? "Users and agents" : "Users",
      lookupGroups: "Groups",
      chooseFirst: "Choose at least one entry.",
      addChosen: ({ count }: { count: number }) => (count > 1 ? `Add ${count}` : "Add"),
      addedPart: ({ count }: { count: number }) =>
        i18n.plural(count, "en", {
          one: "1 entry was added; the rest is still chosen.",
          other: `${count} entries were added; the rest is still chosen.`,
        }),
      added: "Added",
      removed: "Removed",
      descriptionSaved: "Saved",
      posixDone: "Converted",
      groupDeleted: "Group deleted",
      notRemoved: "Not removed",
      notConverted: "Not converted",
      notDeleted: "Not deleted",
      hide: "Hide",
      kind: "Kind",
      people: "People",
      groups: "Groups",
      agentsTitle: "Agents",
      subGroups: "Sub-groups",
      subGroupsMeta: "groups inside this one",
      parentsMeta: "groups that contain it",
      memberMix: ({ people, agents }: { people: number; agents: number }) =>
        agents > 0
          ? `${i18n.plural(people, "en", { one: "1 person", other: `${people} people` })} · ${i18n.plural(agents, "en", { one: "1 agent", other: `${agents} agents` })}`
          : i18n.plural(people, "en", { one: "1 person", other: `${people} people` }),
      noManagers: "nobody yet",
      activity: "Activity",
      activityCreate: "created the group",
      activityUpdate: "changed the description",
      activityPosix: "made it a POSIX group",
      activityMemberAdd: "added {subject}",
      activityMemberRemove: "removed {subject}",
      activityManagerAdd: "made {subject} a manager",
      activityManagerRemove: "removed {subject} as a manager",
      someone: "someone",
      personal: "Personal",
      personalTitle: "Personal Linux group",
      openOwner: "Open user",
      ownedBy: "Belongs to",
      descriptionHint: "Says what the group is for; everyone who can see the group reads it.",
      descriptionTooLong: "Use at most 4000 characters.",
      optional: "optional",
      discardTitle: "Discard changes?",
      discardText: "What you entered is lost.",
      discard: "Discard",
    },
    de: {
      details: "Angaben",
      searchManagers: "Verantwortliche durchsuchen…",
      show: "Anzeigen",
      indirectMembers: "Indirekte Mitglieder",
      agentMemberships: "Agenten",
      clearSearch: "Suche leeren",
      addMembersTitle: "Mitglieder hinzufügen",
      addManagersTitle: "Verantwortliche hinzufügen",
      addToGroupsTitle: "Diese Gruppe zu Gruppen hinzufügen",
      lookupPeople: ({ groups, agents }) =>
        groups && agents ? "Benutzer, Gruppen und Agenten" : groups ? "Benutzer und Gruppen" : agents ? "Benutzer und Agenten" : "Benutzer",
      lookupGroups: "Gruppen",
      chooseFirst: "Wähle mindestens einen Eintrag.",
      addChosen: ({ count }) => (count > 1 ? `${count} hinzufügen` : "Hinzufügen"),
      addedPart: ({ count }) =>
        i18n.plural(count, "de", {
          one: "1 Eintrag wurde hinzugefügt; die übrigen bleiben gewählt.",
          other: `${count} Einträge wurden hinzugefügt; die übrigen bleiben gewählt.`,
        }),
      added: "Hinzugefügt",
      removed: "Entfernt",
      descriptionSaved: "Gespeichert",
      posixDone: "Umgewandelt",
      groupDeleted: "Gruppe gelöscht",
      notRemoved: "Nicht entfernt",
      notConverted: "Nicht umgewandelt",
      notDeleted: "Nicht gelöscht",
      hide: "Ausblenden",
      kind: "Art",
      people: "Personen",
      groups: "Gruppen",
      agentsTitle: "Agenten",
      subGroups: "Untergruppen",
      subGroupsMeta: "Gruppen in dieser Gruppe",
      parentsMeta: "Gruppen, die sie enthalten",
      memberMix: ({ people, agents }) =>
        agents > 0
          ? `${i18n.plural(people, "de", { one: "1 Person", other: `${people} Personen` })} · ${i18n.plural(agents, "de", { one: "1 Agent", other: `${agents} Agenten` })}`
          : i18n.plural(people, "de", { one: "1 Person", other: `${people} Personen` }),
      noManagers: "noch niemand",
      activity: "Aktivität",
      activityCreate: "hat die Gruppe angelegt",
      activityUpdate: "hat die Beschreibung geändert",
      activityPosix: "hat sie zur POSIX-Gruppe gemacht",
      activityMemberAdd: "hat {subject} aufgenommen",
      activityMemberRemove: "hat {subject} entfernt",
      activityManagerAdd: "hat {subject} als verantwortlich eingetragen",
      activityManagerRemove: "hat {subject} als verantwortlich ausgetragen",
      someone: "jemanden",
      personal: "Persönlich",
      personalTitle: "Persönliche Linux-Gruppe",
      openOwner: "Benutzer öffnen",
      ownedBy: "Gehört zu",
      descriptionHint: "Sagt, wofür die Gruppe da ist; alle, die die Gruppe sehen, lesen es.",
      descriptionTooLong: "Höchstens 4000 Zeichen.",
      optional: "optional",
      discardTitle: "Änderungen verwerfen?",
      discardText: "Was du eingegeben hast, geht verloren.",
      discard: "Verwerfen",
    },
  },
});

export type GroupDetailMessages = ReturnType<typeof groupDetailMessages.resolve>["t"];

export const useGroupDetailMessages = () => {
  const locale = useLocale();
  return createMemo(() => groupDetailMessages.resolve([locale()]).t);
};
