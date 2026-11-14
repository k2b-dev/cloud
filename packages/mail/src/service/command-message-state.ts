import { z } from "zod";
import { mailKeywordSchema, type RemoteMessagePrecondition, standardMessageFlagSchema } from "../contracts";

export type MailMessageStateTransition = { field: "flags" | "keywords"; add: boolean; value: string };

/** Apply confirmed transitions; retain receipt-time checks until the first write. */
export const projectMailMessagePrecondition = (
  frozen: RemoteMessagePrecondition,
  transitions: readonly MailMessageStateTransition[],
): RemoteMessagePrecondition => {
  if (transitions.length === 0) return frozen;
  const expected = { ...frozen, modseq: undefined };
  const apply = <T extends string>(current: T[] | undefined, value: T, add: boolean): T[] | undefined => {
    if (current === undefined) return undefined;
    const matches = (item: string): boolean => item.toLocaleLowerCase("und") === value.toLocaleLowerCase("und");
    return add ? (current.some(matches) ? current : [...current, value]) : current.filter((item) => !matches(item));
  };
  for (const transition of transitions) {
    if (transition.field === "flags") {
      // Frozen remote flags use standard names; provider spellings may contain a backslash.
      const flag = standardMessageFlagSchema.parse(transition.value.replace(/^\\/u, "").toLowerCase());
      expected.flags = apply(expected.flags, flag, transition.add);
    } else {
      expected.keywords = apply(expected.keywords, transition.value, transition.add);
    }
  }
  return expected;
};

export const messageStatePayloadSchema = z.object({
  addFlags: z.array(z.enum(["seen", "answered", "flagged", "draft"])).max(4),
  removeFlags: z.array(z.enum(["seen", "answered", "flagged", "draft"])).max(4),
  addKeywords: z.array(z.string().min(1).max(100)).max(100),
  removeKeywords: z.array(z.string().min(1).max(100)).max(100),
});

/** Preserve provider operation order when projecting a confirmed state command. */
export const mailMessageStatePayloadTransitions = (payload: z.infer<typeof messageStatePayloadSchema>): MailMessageStateTransition[] => [
  ...payload.addFlags.map((value): MailMessageStateTransition => ({ field: "flags", add: true, value })),
  ...payload.removeFlags.map((value): MailMessageStateTransition => ({ field: "flags", add: false, value })),
  ...payload.addKeywords.map((value): MailMessageStateTransition => ({ field: "keywords", add: true, value })),
  ...payload.removeKeywords.map((value): MailMessageStateTransition => ({ field: "keywords", add: false, value })),
];

export const normalizeMailKeywords = (keywords: readonly string[]): string[] =>
  keywords
    .flatMap((keyword) => {
      const parsed = mailKeywordSchema.safeParse(keyword);
      return parsed.success ? [parsed.data] : [];
    })
    .sort();
