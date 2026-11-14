import { AnchoredPopover, Button, ChoiceList, IconButton, useLocale } from "@k2b/ui";
import { createSignal, type JSX, Show } from "solid-js";
import type { Principal, ServiceAccountKind } from "../contracts/shared";
import { accessDialogMessages } from "./access-dialog-messages";
import { accessMessages } from "./messages";
import { type GrantableLevel, resolveAllowedLevels } from "./PermissionEditor";
import PrincipalAvatar from "./PrincipalAvatar";

/**
 * One row of an access list, the same in the access dialog and in every editor that lists service accounts: avatar,
 * name (a link where the server offers one), one line below it, and the controls at its end.
 */
export function AccessRowFrame(props: {
  rowKey: string;
  /** A row staged for removal fades, but keeps its place. */
  dimmed?: boolean;
  avatar: { principal: Principal; avatarHash?: string | null; serviceAccountKind?: ServiceAccountKind };
  name: string;
  /** The server offers a link only to whom it may lead: the owner's Code page, or Administration › Code. */
  href?: string;
  /** Beside the name on a wide screen, such as "You" and a mark. */
  nameAside?: JSX.Element;
  /** At the start of the line on a phone, where the marks beside the name go. */
  lineLead?: JSX.Element;
  line: JSX.Element;
  /** A service account's line carries its level, so it wraps on a phone instead of cutting it off. */
  wrapLine?: boolean;
  end: JSX.Element;
}) {
  return (
    <li
      class="flex items-center py-2 max-sm:gap-2 sm:gap-3"
      classList={{ "[&>:first-child]:opacity-50": props.dimmed }}
      data-access-key={props.rowKey}
    >
      <PrincipalAvatar entry={props.avatar} label={props.name} />
      <span class="min-w-0 flex-[1_1_10rem]">
        <span class="flex min-w-0 items-center gap-2 max-sm:text-sm sm:text-[15px] font-medium text-primary">
          <Show
            when={props.href}
            fallback={
              <span data-access-name="" class="min-w-0 break-words">
                {props.name}
              </span>
            }
          >
            {(href) => (
              // A new tab keeps whatever is unsaved here.
              <a data-access-name="" class="min-w-0 break-words hover:underline" href={href()} target="_blank" rel="noopener">
                {props.name}
              </a>
            )}
          </Show>
          {/* Only breakpoint-scoped display classes: an app stylesheet that repeats `contents` or `inline-flex` comes later and would show both marks. */}
          <span class="max-sm:hidden sm:contents">{props.nameAside}</span>
        </span>
        {/*
          On a phone a mark sits in this line: one line height fits it, and it takes a slot of that height at the top of
          the line, so staging a change never makes the row taller and no row below moves.
        */}
        <span class="block text-[13px] leading-5 text-dimmed" classList={{ truncate: !props.wrapLine, "break-words": props.wrapLine }}>
          {props.lineLead}
          {props.line}
        </span>
      </span>
      {props.end}
    </li>
  );
}

/** The level menu and the remove button at a row's end, each in a slot of fixed width so no row moves. */
export function AccessRowControls(props: {
  /** The row's name, for the remove button's label "Remove <name>". */
  name: string;
  menu: JSX.Element;
  /** Replaces "Remove <name>", for example to say why the last manager stays. */
  removeLabel?: string;
  removeDisabled: boolean;
  onRemove: (control: HTMLElement) => void;
}) {
  const locale = useLocale();
  const t = () => accessDialogMessages.resolve([locale()]).t;
  return (
    <span class="ml-auto flex shrink-0 items-center sm:gap-1">
      <span class="max-sm:w-[6.875rem] sm:w-40">{props.menu}</span>
      <IconButton
        label={props.removeLabel ?? t().remove({ name: props.name })}
        variant="ghost"
        size="xs"
        disabled={props.removeDisabled}
        data-access-remove=""
        onClick={(event) => props.onRemove(event.currentTarget)}
      >
        <i class="ti ti-x" aria-hidden="true" />
      </IconButton>
    </span>
  );
}

export type AccessLevelOption = {
  value: string;
  label: string;
  level: GrantableLevel;
  icon?: string;
  disabled?: boolean;
  /** What the level means; defaults to the platform's sentence for its level. */
  description?: string;
};

/** The levels a service account may get, in the platform's words: View and Edit, never Manage. */
export const serviceAccountLevels = (locale: string): AccessLevelOption[] =>
  resolveAllowedLevels(["read", "write"], accessMessages.resolve([locale]).t).map((option) => ({
    value: option.key,
    label: option.label,
    level: option.level,
    icon: option.icon,
  }));

/**
 * The level of one row as a menu of choices, each with what it means, as in the approved mockup. `onRemove` adds
 * "Remove" at its foot.
 */
export function AccessLevelMenu(props: {
  name: string;
  value: string;
  valueLabel: string;
  options: AccessLevelOption[];
  onChange: (value: string) => void;
  disabled: boolean;
  onRemove?: (trigger: HTMLElement) => void;
  removeDisabled?: boolean;
  /** Says why Remove is unavailable, such as for the last manager. */
  removeHint?: string;
}) {
  const locale = useLocale();
  const t = () => accessDialogMessages.resolve([locale()]).t;
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  /** What a level means when the resource gives no sentence of its own. */
  const defaultDescription = (level: GrantableLevel) =>
    level === "read" ? t().levelReadDescription : level === "write" ? t().levelWriteDescription : t().levelAdminDescription;
  const options = () =>
    props.options.map((option) => ({
      value: option.value,
      label: option.label,
      icon: option.icon ? `ti ${option.icon.replace(/^ti\s+/, "")}` : undefined,
      disabled: option.disabled,
      description: option.description ?? defaultDescription(option.level),
    }));
  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="k2b-choice-trigger w-full"
        aria-label={t().levelFor({ name: props.name })}
        aria-haspopup="dialog"
        aria-expanded={open()}
        disabled={props.disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span class="k2b-choice-trigger__value">{props.valueLabel}</span>
        {/* On a phone the chevron moves closer, so the whole level fits beside a mark like "vorher Bearbeiten". */}
        <i class="ti ti-chevron-down max-sm:-ml-1.5" aria-hidden="true" />
      </button>
      {/* Mounted only while open, so a long list carries no menu per row. */}
      <Show when={open()}>
        <AnchoredPopover
          anchor={open() ? trigger : null}
          onClose={() => setOpen(false)}
          label={t().levelFor({ name: props.name })}
          width="21rem"
          initialFocus={() =>
            menu?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]:not(:disabled)') ??
            menu?.querySelector<HTMLElement>('[role="radio"]:not(:disabled)')
          }
        >
          <div ref={menu} class="flex flex-col gap-2 p-2">
            <ChoiceList
              aria-label={t().levelFor({ name: props.name })}
              value={() => props.value}
              options={options()}
              onValueChange={(value) => {
                props.onChange(value);
                setOpen(false);
              }}
            />
            <Show when={props.onRemove}>
              {(remove) => (
                <div class="flex flex-wrap items-center gap-2 px-1 pt-1">
                  <Button
                    variant="text"
                    data-danger="true"
                    disabled={props.removeDisabled}
                    onClick={() => {
                      setOpen(false);
                      if (trigger) remove()(trigger);
                    }}
                  >
                    <i class="ti ti-user-minus" aria-hidden="true" />
                    {t().removeEntry}
                  </Button>
                  <Show when={props.removeHint}>
                    <span class="text-[13px] text-dimmed">{props.removeHint}</span>
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </AnchoredPopover>
      </Show>
    </>
  );
}
