import type { AvatarFacesPerson } from "@k2b/ui";
import type { MailConversationParticipant } from "../../service/conversation-participants";
import type { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import type { MailListItem } from "./mail-navigation";

type Messages = ReturnType<(typeof mailConversationUiMessages)["resolve"]>["t"];

/**
 * Who wrote in a row's conversation and how many. A row without `participants` had only the sender it already names
 * write (the server leaves the list out then), so that sender stands alone.
 */
export const mailRowParticipants = (
  item: Pick<MailListItem, "participants" | "participantCount">,
  sender: string,
): { people: MailConversationParticipant[]; count: number } => {
  const people = item.participants ?? [{ name: sender }];
  return { people, count: Math.max(item.participantCount ?? 0, people.length) };
};

/** Team members keep their tint, automations are square with a robot, and addresses stay gray. */
export const mailParticipantFaces = (people: readonly MailConversationParticipant[]): AvatarFacesPerson[] =>
  people.map((person) =>
    person.kind === "user"
      ? { name: person.name }
      : person.kind
        ? { name: person.name, shape: "square", icon: "ti ti-robot" }
        : { name: person.name, tone: "neutral" },
  );

/** "17 participants · External: … · Team: … and 7 more": the count, then the named people by kind. */
export const mailParticipantSummary = (t: Messages, people: readonly MailConversationParticipant[], count: number): string => {
  const names = (kind: (person: MailConversationParticipant) => boolean) =>
    people
      .filter(kind)
      .map((person) => person.name)
      .join(", ");
  const groups = [
    [t.participantsExternal, names((person) => !person.kind)],
    [t.participantsTeam, names((person) => person.kind === "user")],
    [t.participantsAutomations, names((person) => person.kind === "service_account" || person.kind === "workflow")],
  ] as const;
  const parts = groups.flatMap(([label, list]) => (list ? [label({ names: list })] : []));
  const more = count - people.length;
  const last = parts.at(-1);
  const named = more > 0 && last ? [...parts.slice(0, -1), t.participantsMore({ names: last, count: more })] : parts;
  return [t.participants({ count }), ...named].join(" · ");
};
