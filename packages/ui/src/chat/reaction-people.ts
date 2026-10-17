import { chatMessages } from "./chat-messages";

export type ReactionPeopleInput = {
  /** Display names of the others who reacted, in the order they reacted; without the reader. */
  names: readonly string[];
  /** The reader reacted too; they come first as "You". */
  own?: boolean;
  /** How many reacted in total, the reader included. May exceed the names given. */
  count: number;
};

export const reactionPeople = (input: ReactionPeopleInput, locale = "en"): string => {
  const messages = chatMessages.resolve([locale]).t;
  const people = input.own ? [messages.reactionYou, ...input.names] : [...input.names];
  const total = Math.max(input.count, people.length);
  if (total <= 3 && people.length === total) {
    if (people.length < 2) return people.join("");
    return `${people.slice(0, -1).join(", ")} ${messages.reactionAnd} ${people.at(-1)}`;
  }
  const shown = people.slice(0, 2);
  return [...(shown.length ? [shown.join(", ")] : []), messages.reactionMorePeople({ count: total - shown.length })].join(" ");
};
