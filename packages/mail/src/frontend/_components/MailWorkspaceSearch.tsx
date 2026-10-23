import { Button, FilterChip, IconButton, TextInput, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import { DEFAULT_MAIL_QUICK_SEARCH_FIELDS } from "../../search-url";
import { mailConversationListMessages } from "./mail-conversation-list-messages";
import { type createMailboxSearch, isDefaultQuickSearch } from "./mailbox-search";

type Search = ReturnType<typeof createMailboxSearch>;

export function MailSearchTrigger(props: { search: Search; unseen?: boolean }) {
  const locale = useLocale();
  const text = createMemo(() => mailConversationListMessages.resolve([locale()]).t);
  return (
    <span class="mail-search-trigger">
      <Tooltip.Anchor content={text().openSearch}>
        <IconButton
          ref={props.search.triggerRef}
          type="button"
          label={text().openSearch}
          aria-expanded={props.search.opened()}
          onClick={(event) => props.search.open(event.currentTarget)}
          data-mail-search-trigger
        >
          <i class="ti ti-search" aria-hidden="true" />
        </IconButton>
      </Tooltip.Anchor>
      <Show when={props.unseen}>
        <span class="mail-search-discovery-dot" aria-hidden="true" />
      </Show>
    </span>
  );
}

/** The input and its options occupy the existing head slots, including the phone's second row. */
export function MailSearchInput(props: { search: Search; mailboxName: string }) {
  const locale = useLocale();
  const text = createMemo(() => mailConversationListMessages.resolve([locale()]).t);
  return (
    <form class="mail-head-search-input" data-mail-head-search role="search" onSubmit={props.search.submitSearch}>
      <TextInput
        ref={props.search.inputRef}
        error={props.search.validationError() ? text().searchTooLong : undefined}
        type="search"
        name="q"
        aria-label={text().searchMailboxName({ name: props.mailboxName })}
        placeholder={text().searchMailbox}
        icon="ti ti-search"
        activeIcon="ti ti-search"
        value={props.search.searchValue}
        onValueChange={props.search.updateSearchValue}
        clearable
        onClear={props.search.clearSearch}
        maxLength={500}
        suffix={<kbd class="mail-search-escape">Esc</kbd>}
      />
      <Button class="mail-head-search-close-phone" type="button" variant="ghost" size="sm" onClick={props.search.close}>
        <span
          classList={{ invisible: Boolean(props.search.searchValue().trim()) }}
          aria-hidden={Boolean(props.search.searchValue().trim())}
        >
          {text().cancelSearch}
        </span>
        <span classList={{ invisible: !props.search.searchValue().trim() }} aria-hidden={!props.search.searchValue().trim()}>
          {text().resetSearch}
        </span>
      </Button>
    </form>
  );
}

export function MailSearchOptions(props: { search: Search; count: number }) {
  const locale = useLocale();
  const text = createMemo(() => mailConversationListMessages.resolve([locale()]).t);
  return (
    <span class="contents" data-mail-head-search-options>
      <FilterChip
        label={text().searchInValue({ value: props.search.searchFieldsLabel() })}
        icon="ti ti-filter-search"
        options={[{ label: text().searchIn, options: props.search.quickSearchFieldOptions(), multiple: true }]}
        value={props.search.searchFields()}
        defaultValue={[...DEFAULT_MAIL_QUICK_SEARCH_FIELDS]}
        isActive={!isDefaultQuickSearch(props.search.searchFields())}
        onValueChange={props.search.updateSearchFields}
        position="bottom-right"
      />
      <FilterChip
        label={text().placeValue({
          value: props.search.scopeFolderId()
            ? text().onlyFolder({ name: props.search.scopeFolder()?.name ?? props.search.scopeFolderId()! })
            : text().wholeMailbox,
        })}
        icon="ti ti-map-pin"
        options={[
          {
            label: text().place,
            options: [
              { value: "", label: text().wholeMailbox },
              ...(props.search.scopeFolderId() && props.search.scopeFolderId() !== props.search.originFolder()?.id
                ? [
                    {
                      value: props.search.scopeFolderId()!,
                      label: text().onlyFolder({ name: props.search.scopeFolder()?.name ?? props.search.scopeFolderId()! }),
                    },
                  ]
                : []),
              ...(props.search.originFolder()
                ? [{ value: props.search.originFolder()!.id, label: text().onlyFolder({ name: props.search.originFolder()!.name }) }]
                : []),
            ],
          },
        ]}
        value={[props.search.scopeFolderId() ?? ""]}
        defaultValue={[""]}
        isActive={Boolean(props.search.scopeFolderId())}
        onValueChange={(values) => props.search.updateScope(values[0] || null)}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="mail-search-advanced"
        aria-label={text().searchFilters}
        tooltip={text().searchFilters}
        aria-haspopup="dialog"
        aria-pressed={Boolean(props.search.structuredSummary())}
        aria-busy={props.search.searchBuilderLoading() ? "true" : undefined}
        onClick={() => void props.search.openAdvancedSearch()}
      >
        <i class={props.search.searchBuilderLoading() ? "ti ti-loader-2 animate-spin" : "ti ti-adjustments-search"} aria-hidden="true" />
        <span class="mail-search-advanced-label" aria-hidden="true">
          {text().advancedSearch}
        </span>
      </Button>
      <Show when={props.search.searchValue().trim()}>
        <span class="text-xs text-muted whitespace-nowrap" aria-live="polite">
          {text().matches({ count: props.count })}
        </span>
      </Show>
      <Button class="mail-head-search-close-desktop" type="button" variant="ghost" size="sm" onClick={props.search.close}>
        {props.search.searchValue().trim() ? text().resetSearch : text().cancelSearch}
      </Button>
    </span>
  );
}
