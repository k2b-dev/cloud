import { Dropdown, IconButton, useLocale } from "@k2b/ui";
import { createMemo, type JSX, Show } from "solid-js";
import type { SpaceItemTemplate } from "@/contracts";
import { buildSpaceHref } from "@/routes";
import { CreateMenu } from "../frontend/[id]/_components/sidebar/CreateMenu";
import type { Outgoing } from "./create";
import { myTasksMessages } from "./messages";
import type { PwaStatus } from "./space";

/** Where a new task lands: a Space with its statuses and task templates. */
export type QuickAddTarget = { shortId: string; name: string; color: string; statuses: PwaStatus[]; templates: SpaceItemTemplate[] };

/** The first status that does not complete its tasks; new tasks start there. */
export const firstOpenStatus = (statuses: readonly PwaStatus[]) => statuses.find((status) => !status.done);

type BarProps = {
  /** In a Space, "New task" opens the "+" menu with its templates; in "My tasks" it opens the field at once. */
  target?: QuickAddTarget;
  /** Why adding is off, such as being offline; the bar then says so and stays in place. */
  blocked?: string;
  onOpen: (template?: SpaceItemTemplate) => void;
};

/** "New task" under the thumb, with the sentence that says why it is off, if it is. */
export function AddBar(props: BarProps) {
  const locale = useLocale();
  const t = () => myTasksMessages.resolve([locale()]).t;
  const label = (): JSX.Element => (
    <>
      <i class="ti ti-plus" aria-hidden="true" />
      {t().newTask}
    </>
  );
  return (
    <div class="spaces-pwa-add" data-k2b-shell-bottom>
      <Show when={props.blocked}>
        {(reason) => (
          <p class="spaces-pwa__offline" role="status">
            <i class={props.target && reason() === t().noOpenStatus ? "ti ti-info-circle" : "ti ti-wifi-off"} aria-hidden="true" />
            {reason()}
          </p>
        )}
      </Show>
      <Show
        when={props.target}
        fallback={
          <button type="button" class="spaces-pwa-add__trigger" disabled={Boolean(props.blocked)} onClick={() => props.onOpen()}>
            {label()}
          </button>
        }
      >
        {(target) => (
          <CreateMenu
            kind="task"
            templates={target().templates}
            title={t().newTaskIn({ space: target().name })}
            disabled={Boolean(props.blocked)}
            choose={(choice) => {
              if (choice.type === "blank") props.onOpen();
              else if (choice.type === "template") props.onOpen(choice.template);
              // The template editor lives in the Space on the web, where "+" offers "Create template" too.
              else window.location.assign(buildSpaceHref(target().shortId));
            }}
          >
            <Dropdown.Trigger appearance="plain" class="spaces-pwa-add__trigger" disabled={Boolean(props.blocked)}>
              {label()}
            </Dropdown.Trigger>
          </CreateMenu>
        )}
      </Show>
    </div>
  );
}

/** A task on its way: a spinner while it saves; ↻ when no answer came, which repeats the same request; the reason when refused. */
export function OutgoingRow(props: { entry: Outgoing; onResend?: (key: string) => void }) {
  const locale = useLocale();
  const t = () => myTasksMessages.resolve([locale()]).t;
  const failed = () => props.entry.state === "unconfirmed" || props.entry.state === "refused";
  const text = createMemo(() =>
    props.entry.state === "saving" ? t().creating : props.entry.state === "unconfirmed" ? t().unconfirmed : (props.entry.reason ?? ""),
  );
  return (
    <li class="spaces-pwa__row spaces-pwa-space__row" data-state={props.entry.state}>
      <Show
        when={props.entry.state === "unconfirmed"}
        fallback={
          <span class="spaces-pwa__event" role="img" aria-label={props.entry.state === "saving" ? t().creating : t().notCreated}>
            <i
              class={props.entry.state === "saving" ? "ti ti-loader-2 k2b-spin" : "ti ti-alert-circle spaces-pwa-composer__refused"}
              aria-hidden="true"
            />
          </span>
        }
      >
        <IconButton
          class="spaces-pwa__check spaces-pwa-composer__resend"
          label={t().resend({ title: props.entry.title })}
          tooltip={false}
          onClick={() => props.onResend?.(props.entry.key)}
        >
          <i class="ti ti-refresh" aria-hidden="true" />
        </IconButton>
      </Show>
      <span class="spaces-pwa__copy">
        <span class="spaces-pwa__title">{props.entry.title}</span>
        <span class="spaces-pwa__meta">
          <span class={failed() ? "spaces-pwa-composer__failed" : undefined} role={failed() ? "alert" : undefined}>
            {text()}
          </span>
        </span>
      </span>
    </li>
  );
}
