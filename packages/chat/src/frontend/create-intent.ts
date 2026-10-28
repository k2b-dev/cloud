import { createSignal, onMount } from "solid-js";
import { z } from "zod";
import { CreateConversationSchema, MEMBER_PAGE_SIZE, MemberPrincipalSchema, MemberSchema } from "../service/contracts";
import { ChatRequestError } from "./chat-store";
import type { ChosenMember } from "./MemberPicker";

const PendingSchema = z.object({
  input: CreateConversationSchema.extend({ createKey: z.uuid() }),
  chosen: z
    .array(
      z.object({
        principal: MemberPrincipalSchema,
        displayName: z.string(),
        serviceAccountKind: MemberSchema.shape.serviceAccountKind.optional(),
      }),
    )
    .max(MEMBER_PAGE_SIZE),
});
type Pending = z.infer<typeof PendingSchema>;

/** One unresolved submission, retained in this tab until an answer or explicit cancellation. */
export const createIntent = (scope: string, restore: (intent: Pending) => void) => {
  const key = `chat.create:${scope}`;
  let uncertain = false;
  const [pending, setPending] = createSignal<Pending>();
  const save = (value: Pending | undefined) => {
    setPending(value);
    try {
      if (value) window.sessionStorage.setItem(key, JSON.stringify(value));
      else window.sessionStorage.removeItem(key);
    } catch {
      // A browser that disallows storage still supports safe retries while this dialog stays open.
    }
  };
  onMount(() => {
    try {
      const raw = window.sessionStorage.getItem(key);
      if (!raw) return;
      const parsed = PendingSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return save(undefined);
      uncertain = true; // A previous document may have sent this request before it was interrupted.
      setPending(parsed.data);
      restore(parsed.data);
    } catch {
      // Storage is optional; no request has been made by restoring the dialog.
    }
  });
  return {
    pending,
    begin(input: z.input<typeof CreateConversationSchema>, chosen: ChosenMember[]) {
      const previous = pending();
      if (previous) return previous.input;
      const intent = PendingSchema.parse({ input: { ...input, createKey: crypto.randomUUID() }, chosen });
      uncertain = false;
      save(intent);
      return intent.input;
    },
    failed(error: unknown) {
      // A definitive first rejection permits correction. After any uncertain attempt, keep the key:
      // a later authorization/validation rejection cannot prove that the earlier write did not commit.
      if (!uncertain && error instanceof ChatRequestError && error.status >= 400 && error.status < 500 && error.status !== 429)
        save(undefined);
      else uncertain = true;
    },
    clear: () => save(undefined),
  };
};
