import { Chip, Inline, Lookup, Popover, Text, useLocale } from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Principal, ServiceAccountKind } from "../contracts/shared";
import { accessMessages } from "./messages";
import { principalFace } from "./principal-face";
import { principalKey } from "./principal-key";
import { type PrincipalSearchEntry, type PrincipalSearchOptions, searchPrincipals } from "./principal-search";

/** One principal the picker holds: who it is and how it shows. */
export type PickedPrincipal = {
  principal: Principal;
  display: { displayName: string; avatarHash?: string | null; serviceAccountKind?: ServiceAccountKind };
};

export type PrincipalPickerV2Props = PrincipalSearchOptions & {
  /** The name of what is picked, such as "Personen"; the add button and the search are named after it. */
  label: string;
  /** The chosen principals, in their order. */
  value: readonly PickedPrincipal[];
  /** Every pick and every removal applies at once. */
  onChange: (value: PickedPrincipal[]) => void;
  /** One principal at a time: a pick replaces the one before. Several by default. */
  single?: boolean;
  disabled?: boolean;
};

/**
 * The v2 principal picker: the chosen people, groups and service accounts as chips, each removable by its name, and
 * "Hinzufügen" that opens a search beside the field (a sheet on the phone); with `single` a pick replaces the one
 * before and closes the search. The search asks the directory as the
 * viewer may see it (`searchPrincipals`, the same as the v1 `PrincipalPicker`): typing waits 200 ms and a newer
 * search aborts the one before; each match shows its face (a person's avatar, a group's or a Code account's mark) and
 * its kind. A principal already on the list (`existing`) stays in the results with `takenReason`, dimmed, or is left
 * out without one. Service accounts are offered by default (`allowServiceAccounts`); restricting them needs a
 * documented reason (`principal-picker-kinds`).
 */
export function PrincipalPickerV2(props: PrincipalPickerV2Props) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  // Everything a search found, by key, so a pick knows its principal and face; the chosen ones always.
  const known = new Map<string, PickedPrincipal>();
  for (const picked of props.value) known.set(principalKey(picked.principal), picked);
  const keys = createMemo(() => props.value.map((picked) => principalKey(picked.principal)));
  const itemOf = (entry: PrincipalSearchEntry, unavailable?: string): LookupItem => ({
    value: principalKey(entry.principal),
    label: entry.label,
    meta: entry.description ?? entry.badge,
    face: principalFace(entry.principal, entry.label, entry),
    ...(unavailable ? { unavailable } : {}),
  });
  const pickedItem = (picked: PickedPrincipal): LookupItem => ({
    value: principalKey(picked.principal),
    label: picked.display.displayName,
    face: principalFace(picked.principal, picked.display.displayName, picked.display),
  });
  const load = async (query: string, context: { signal: AbortSignal; limit: number }) => {
    const entries = await searchPrincipals(query, props, context.signal, locale());
    const existing = new Set(props.existing?.map(principalKey));
    const items: LookupItem[] = [];
    for (const entry of entries) {
      const key = principalKey(entry.principal);
      known.set(key, {
        principal: entry.principal,
        display: { displayName: entry.label, avatarHash: entry.avatarHash, serviceAccountKind: entry.serviceAccountKind },
      });
      if (!existing.has(key)) items.push(itemOf(entry));
      else {
        const reason = props.takenReason?.(entry.principal);
        if (reason) items.push(itemOf(entry, reason));
      }
    }
    return { items };
  };
  // a single pick closes the search: the field shows what was picked
  const [open, setOpen] = createSignal(false);
  const pick = (next: string[]) => {
    const chosen = props.single ? next.filter((key) => !keys().includes(key)).slice(-1) : next;
    props.onChange(chosen.flatMap((key) => known.get(key) ?? []));
    if (props.single && chosen.length > 0) setOpen(false);
  };
  const remove = (picked: PickedPrincipal) =>
    props.onChange(props.value.filter((other) => principalKey(other.principal) !== principalKey(picked.principal)));
  return (
    <Inline>
      <For each={props.value}>
        {(picked) => (
          <Show when={!props.disabled} fallback={<Chip>{picked.display.displayName}</Chip>}>
            <Chip remove={{ name: t().removePrincipal({ name: picked.display.displayName }), onClick: () => remove(picked) }}>
              {picked.display.displayName}
            </Chip>
          </Show>
        )}
      </For>
      <Show when={!props.disabled}>
        <Popover
          title={props.label}
          variant="ghost"
          icon={props.single && props.value.length > 0 ? "pencil" : "plus"}
          open={open()}
          onOpenChange={setOpen}
          content={<Lookup label={props.label} value={keys()} onChange={pick} load={load} known={props.value.map(pickedItem)} limit={10} />}
        >
          {props.single ? (props.value.length > 0 ? t().change : props.label) : t().add}
        </Popover>
      </Show>
      <Show when={props.disabled && props.value.length === 0}>
        <Text muted>{t().nobodyChosen}</Text>
      </Show>
    </Inline>
  );
}
