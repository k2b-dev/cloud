import { PrincipalPicker, principalKey } from "@k2b/cloud/access/ui";
import { CloudAvatar } from "@k2b/cloud/account/ui";
import { Combobox, IconButton } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import { MEMBER_PAGE_SIZE, type MemberPrincipal } from "../service/contracts";
import { type ChatDialogStore, useChatMessages } from "./chat-dialog";

export type ChosenMember = { principal: MemberPrincipal; displayName: string };

/** A person's avatar, or the quiet round tile the permission editor shows for a group. */
export function MemberAvatar(props: { principal: MemberPrincipal; displayName: string; avatarHash?: string | null }): JSX.Element {
  return (
    <Show
      when={props.principal.type === "user" ? props.principal.userId : undefined}
      fallback={
        <span
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-secondary dark:bg-zinc-700"
          aria-hidden="true"
        >
          <i class="ti ti-users-group text-sm" />
        </span>
      }
    >
      {(userId) => (
        <CloudAvatar username={props.displayName} userId={userId()} avatarHash={props.avatarHash} size="xs" class="h-7 w-7 shrink-0" />
      )}
    </Show>
  );
}

/**
 * Chooses the people, and for full accounts the directory groups, of a new chat or of an addition. Full accounts search
 * the Cloud directory through the platform picker. Guests cannot search it and cannot add groups, so they choose from
 * the people they already share a chat with, rendered the way the platform picker renders people.
 */
export default function MemberPicker(props: {
  guest: boolean;
  chosen: readonly ChosenMember[];
  /** Already in the chat, or the viewer: never offered. */
  excluded: readonly MemberPrincipal[];
  people: ChatDialogStore["people"];
  disabled?: boolean;
  onChange: (chosen: ChosenMember[]) => void;
}): JSX.Element {
  const t = useChatMessages();
  let field: HTMLDivElement | undefined;
  const taken = () => [...props.excluded, ...props.chosen.map((member) => member.principal)];
  // A chat takes at most one page of new entries per request.
  const full = () => props.chosen.length >= MEMBER_PAGE_SIZE;
  const choose = (principal: MemberPrincipal, displayName: string) => {
    if (taken().some((known) => principalKey(known) === principalKey(principal))) return;
    props.onChange([...props.chosen, { principal, displayName }]);
  };
  const remove = (member: ChosenMember) => {
    props.onChange(props.chosen.filter((other) => principalKey(other.principal) !== principalKey(member.principal)));
    field?.querySelector("input")?.focus();
  };
  return (
    <div class="flex flex-col gap-2">
      <div ref={field} role="group" aria-label={t().people}>
        <Show
          when={props.guest}
          fallback={
            <PrincipalPicker
              existing={taken()}
              allowServiceAccounts={false}
              allowAuthenticated={false}
              disabled={props.disabled || full()}
              onSelect={(principal, display) => {
                if (principal.type === "user" || principal.type === "group") choose(principal, display.displayName);
              }}
            />
          }
        >
          <Combobox
            aria-label={t().addPerson}
            placeholder={t().addPerson}
            description={t().guestPickerDescription}
            disabled={props.disabled || full()}
            fetchData={async (search, signal) => {
              const page = await props.people(search.trim().slice(0, 100), signal);
              const known = new Set(taken().map(principalKey));
              return page.items
                .filter((person) => !known.has(principalKey({ type: "user", userId: person.id })))
                .map((person) => ({ id: person.id, label: person.displayName, icon: "ti-user" }));
            }}
            onSelect={(person) => choose({ type: "user", userId: person.id }, person.label)}
          />
        </Show>
      </div>
      <Show when={props.chosen.length > 0}>
        <ul class="flex flex-col" aria-label={t().chosenPeople}>
          <For each={props.chosen}>
            {(member) => (
              <li class="chat-member-row">
                <MemberAvatar principal={member.principal} displayName={member.displayName} />
                <span class="min-w-0 flex-1 truncate text-sm">{member.displayName}</span>
                <IconButton
                  label={t().removeName({ name: member.displayName })}
                  size="xs"
                  variant="ghost"
                  disabled={props.disabled}
                  onClick={() => remove(member)}
                >
                  <i class="ti ti-x" aria-hidden="true" />
                </IconButton>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
