import type { CodeAttention } from "@k2b/cloud/ssr/code-page";

/**
 * The mailbox's "Code" entry: its administrators always get it, and anyone else who may see the Code once Core said so.
 * The warning dot needs Core's answer; without it the entry stays plain, never an error.
 */
export const mailCodeEntry = (input: {
  mailboxAdmin: boolean;
  attention: CodeAttention | null;
  active: boolean;
}): { active: boolean; attention?: boolean } | undefined =>
  input.mailboxAdmin || input.attention?.visible
    ? { active: input.active, ...(input.attention?.attention ? { attention: true } : {}) }
    : undefined;
