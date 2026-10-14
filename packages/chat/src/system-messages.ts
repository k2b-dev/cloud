import { chatMessages } from "./messages";
import type { SystemMessage } from "./service/contracts";

export const renderSystemMessage = (system: SystemMessage, authorName: string, locale?: string): string => {
  const resolved = chatMessages.resolve(locale ? [locale] : []);
  const t = resolved.t;
  const actor = authorName;
  switch (system.code) {
    case "conversation_created":
      return t.systemCreated({ actor });
    case "details_changed": {
      const { name, icon, purpose } = system.params;
      if (name === undefined) return t.systemDetails({ actor });
      const details = icon !== undefined || purpose !== undefined;
      if (name === null) return details ? t.systemNameRemovedWithDetails({ actor }) : t.systemNameRemoved({ actor });
      return details ? t.systemRenamedWithDetails({ actor, name }) : t.systemRenamed({ actor, name });
    }
    case "members_added":
    case "groups_added": {
      const members = system.code === "members_added" ? system.params.members : system.params.groups;
      // A fourth name reads better than "and 1 others", so only five or more members are counted.
      const shown = members.length > 4 ? 3 : members.length;
      const names = members.slice(0, shown).map((member) => member.name);
      if (members.length > shown) names.push(t.systemOthers({ count: members.length - shown }));
      const formatted = new Intl.ListFormat(resolved.locale, { style: "long", type: "conjunction" }).format(names);
      return system.code === "members_added"
        ? t.systemAdded({ actor, names: formatted })
        : t.systemGroupsAdded({ actor, names: formatted, count: members.length });
    }
    case "group_removed":
      return t.systemGroupRemoved({ actor, name: system.params.group.name });
    case "manager_assigned":
      return t.systemManagerAssigned({ name: system.params.member.name });
    case "member_removed":
      return t.systemRemoved({ actor, name: system.params.member.name });
    case "member_left":
      return system.params.successor ? t.systemSuccessor({ actor, name: system.params.successor.name }) : t.systemLeft({ actor });
    case "permission_changed": {
      const permission =
        system.params.permission === "read"
          ? t.permissionRead
          : system.params.permission === "write"
            ? t.permissionWrite
            : t.permissionManage;
      return t.systemPermission({ actor, name: system.params.member.name, permission });
    }
  }
};

export const messagePreview = (body: string): string => [...body.replace(/\s+/gu, " ").trim()].slice(0, 140).join("");
