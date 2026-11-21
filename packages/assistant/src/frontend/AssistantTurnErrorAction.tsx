import type { AiTurnError } from "@k2b/cloud/ai";
import { ButtonLink, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { assistantMessages } from "./messages";

/** Core's host_rejected currently names an automation model without a budgetable price. */
export default function AssistantTurnErrorAction(props: { error: AiTurnError; canConfigure: boolean }) {
  const locale = useLocale();
  return (
    <Show when={props.canConfigure && props.error.code === "host_rejected"}>
      <ButtonLink href="/admin/ai?sec=providers" variant="secondary" size="sm">
        {assistantMessages.resolve([locale()]).t.modelManagement}
      </ButtonLink>
    </Show>
  );
}
