import { createApiClient } from "@k2b/cloud/browser";
import { consumeCommandLink, registerCommandHandler } from "@k2b/cloud/browser/commands";
import { onCleanup, onMount } from "solid-js";
import type { ApiType } from "../api";
import { ChatComposeInputSchema } from "../commands";
import { PeoplePageSchema } from "../service/contracts";
import type { ChosenMember } from "./MemberPicker";

/** Commands only prepare the normal form. Its submit and the service still own creation and duplicate choice. */
export const createChatCommands = (open: (person: ChosenMember, active: () => boolean) => Promise<void>, failed: () => string) => {
  let active = true;
  let pending = false;
  const abort = new AbortController();
  onCleanup(() => {
    active = false;
    abort.abort();
  });
  onMount(() => {
    const client = createApiClient<ApiType>({ baseUrl: "/api/chat" });
    onCleanup(
      registerCommandHandler("chat.conversation.compose", ChatComposeInputSchema, async ({ userId }) => {
        if (pending) throw new Error(failed());
        pending = true;
        try {
          const response = await client.people[":userId"].$get({ param: { userId } }, { init: { signal: abort.signal } });
          if (!active) return;
          if (!response.ok) throw new Error(failed());
          const person = PeoplePageSchema.shape.items.element.parse(await response.json());
          if (!active) return;
          await open({ principal: { type: "user", userId: person.id }, displayName: person.displayName }, () => active);
        } catch (error) {
          if (active) throw new Error(failed(), { cause: error });
        } finally {
          pending = false;
        }
      }),
    );
    void consumeCommandLink();
  });
};
