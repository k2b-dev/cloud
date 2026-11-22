/**
 * @k2b/ui v2 overlays: behaviour (focus, keyboard, ARIA, dismissal, positioning) from ui-sdk, look from v2.css.
 * Each wrapper fixes the structure of the flat look (head band, body, foot band; rows to the menu edge), so an app
 * passes content, not layout. Use them inside islands: they need the browser.
 */
import { For, type ParentProps, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  Combobox as SdkCombobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@ui-sdk/solid/combobox";
import {
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Dialog as SdkDialog,
} from "@ui-sdk/solid/dialog";
import { MenuContent, MenuItem, MenuSeparator, MenuTrigger, Menu as SdkMenu } from "@ui-sdk/solid/menu";
import { type IconName } from "./icons";
import { buttonLook, Icon } from "./primitives";

type TriggerLook = { label: string; icon?: IconName; variant?: "primary" | "ghost"; iconOnly?: boolean; edge?: boolean };

const TriggerContent = (props: { look: TriggerLook }) => (
  <>
    <Show when={props.look.icon}>{(name) => <Icon name={name()} />}</Show>
    <Show when={!props.look.iconOnly} fallback={<span class="k2-sr">{props.look.label}</span>}>
      {props.look.label}
    </Show>
  </>
);

const triggerAttrs = (look: TriggerLook) => buttonLook({ variant: look.variant, iconOnly: look.iconOnly, edge: look.edge });

// ── Dialog ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A modal dialog: head band with title and close, a body, and a foot band with the actions. A sheet on phones. */
export function Dialog(
  props: ParentProps<{ trigger: TriggerLook; title: string; footer: JSX.Element; notice?: JSX.Element; open?: boolean; onOpenChange?: (open: boolean) => void }>,
) {
  return (
    <SdkDialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogTrigger {...triggerAttrs(props.trigger)}>
        <TriggerContent look={props.trigger} />
      </DialogTrigger>
      <DialogBackdrop class="k2-veil" />
      <DialogContent class="k2-dialog">
        <header class="k2-head" data-edge="end">
          <DialogTitle class="k2-head__title">{props.title}</DialogTitle>
          <div class="k2-head__acts">
            <DialogClose {...buttonLook({ variant: "ghost", iconOnly: true })} aria-label="Schließen">
              <Icon name="x" />
            </DialogClose>
          </div>
        </header>
        <div class="k2-dialog__body">{props.children}</div>
        {props.notice}
        <footer class="k2-dialog__foot">{props.footer}</footer>
      </DialogContent>
    </SdkDialog>
  );
}

/** The quiet way out of a dialog. */
export function DialogCancel(props: ParentProps) {
  return <DialogClose {...buttonLook({})}>{props.children}</DialogClose>;
}

// ── Menu ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export type MenuEntry = { value: string; label: string; icon?: IconName; tone?: "bad" } | { separator: true };

/** An action menu: rows reach the menu edge, the radius clips the highlighted row. */
export function ActionMenu(props: { trigger: TriggerLook; items: MenuEntry[]; onAction: (value: string) => void }) {
  return (
    <SdkMenu onAction={(value) => props.onAction(String(value))}>
      <MenuTrigger {...triggerAttrs(props.trigger)}>
        <TriggerContent look={props.trigger} />
      </MenuTrigger>
      <MenuContent class="k2-menu" align="end" sideOffset={4} collisionPadding={8}>
        <For each={props.items}>
          {(entry) => (
            <Show
              when={"value" in entry ? (entry as Extract<MenuEntry, { value: string }>) : undefined}
              fallback={<MenuSeparator />}
            >
              {(item) => (
                <MenuItem value={item().value} data-tone={item().tone}>
                  <Show when={item().icon}>{(name) => <Icon name={name()} />}</Show>
                  {item().label}
                </MenuItem>
              )}
            </Show>
          )}
        </For>
      </MenuContent>
    </SdkMenu>
  );
}

// ── Combobox field ────────────────────────────────────────────────────────────────────────────────────────────────
export type ComboboxOption = { value: string; label: string; hint?: string };

/** A field (label row 20 px, control 36 px) whose input filters a list. */
export function ComboboxField(props: {
  label: string;
  placeholder?: string;
  options: ComboboxOption[];
  value?: string | null;
  onValueChange?: (value: string | null) => void;
  empty?: string;
}) {
  return (
    <SdkCombobox<string>
      value={props.value}
      onValueChange={(next) => props.onValueChange?.(next ?? null)}
      itemToLabel={(value: string) => props.options.find((option) => option.value === value)?.label ?? value}
    >
      <div class="k2-field">
        <ComboboxLabel class="k2-field__label">{props.label}</ComboboxLabel>
        <ComboboxInput class="k2-input" placeholder={props.placeholder} />
      </div>
      <ComboboxContent class="k2-combobox__popup" sideOffset={4} collisionPadding={8}>
        <ComboboxList>
          <For each={props.options}>
            {(option) => (
              <ComboboxItem value={option.value}>
                <span class="k2-fill k2-cut">{option.label}</span>
                <Show when={option.hint}>
                  <span class="k2-meta">{option.hint}</span>
                </Show>
              </ComboboxItem>
            )}
          </For>
        </ComboboxList>
        <ComboboxEmpty>{props.empty ?? "Nichts gefunden."}</ComboboxEmpty>
      </ComboboxContent>
    </SdkCombobox>
  );
}
