import { TextInput, useLocale } from "@k2b/ui";
import { createEffect, createMemo, type JSX } from "solid-js";
import { mailConversationListMessages } from "./mail-conversation-list-messages";
import type { createMailboxSearch } from "./mailbox-search";

type Search = ReturnType<typeof createMailboxSearch>;

/**
 * The mailbox's large search field, always in the head. `children` stand right after it, such as the filter button,
 * so the field and what narrows it form one group.
 */
export function MailSearchInput(props: { search: Search; mailboxName: string; children?: JSX.Element }) {
  const locale = useLocale();
  const text = createMemo(() => mailConversationListMessages.resolve([locale()]).t);
  let input: HTMLInputElement | undefined;
  createEffect(() => {
    const search = props.search;
    if (input) search.inputRef(input);
  });
  return (
    <form class="mail-head-search-input" data-mail-head-search role="search" onSubmit={(event) => props.search.submitSearch(event)}>
      <TextInput
        ref={(element) => {
          input = element;
          props.search.inputRef(element);
        }}
        error={props.search.validationError() ? text().searchTooLong : undefined}
        type="search"
        name="q"
        aria-label={text().searchMailboxName({ name: props.mailboxName })}
        placeholder={text().searchMailboxName({ name: props.mailboxName })}
        icon="ti ti-search"
        activeIcon="ti ti-search"
        value={props.search.searchValue}
        onValueChange={props.search.updateSearchValue}
        clearable
        onClear={props.search.clearSearch}
        maxLength={500}
      />
      {props.children}
    </form>
  );
}
