import { Button, Dropdown, type DropdownItem, FilterChip, FilterToggle, IconButton, TextInput, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, createMemo, Show } from "solid-js";
import { mailFolderNames } from "../../folder-names";
import { DEFAULT_MAIL_QUICK_SEARCH_FIELDS } from "../../search-url";
import { mailConversationListMessages } from "./mail-conversation-list-messages";
import { type createMailboxSearch, isDefaultQuickSearch } from "./mailbox-search";

type Search = ReturnType<typeof createMailboxSearch>;

export function MailSearchTrigger(props: { search: Search; unseen?: boolean }) {
  const locale = useLocale();
  const text = createMemo(() => mailConversationListMessages.resolve([locale()]).t);
  let trigger: HTMLButtonElement | undefined;
  createEffect(() => {
    const search = props.search;
    if (trigger) search.triggerRef(trigger);
  });
  return (
    <span class="mail-search-trigger">
      <Tooltip.Anchor content={text().openSearch}>
        <IconButton
          ref={(element) => {
            trigger = element;
            props.search.triggerRef(element);
          }}
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
  const folderName = createMemo(() => mailFolderNames(locale()));
  const scopeFolderName = () => {
    const folder = props.search.scopeFolder();
    return folder ? folderName()(folder) : props.search.scopeFolderId()!;
  };
  const placeOptions = () => [
    { value: "", label: text().wholeMailbox },
    ...(props.search.scopeFolderId() && props.search.scopeFolderId() !== props.search.originFolder()?.id
      ? [{ value: props.search.scopeFolderId()!, label: text().onlyFolder({ name: scopeFolderName() }) }]
      : []),
    ...(props.search.originFolder()
      ? [{ value: props.search.originFolder()!.id, label: text().onlyFolder({ name: folderName()(props.search.originFolder()!) }) }]
      : []),
  ];
  const placeLabel = () => (props.search.scopeFolderId() ? text().onlyFolder({ name: scopeFolderName() }) : text().wholeMailbox);
  const summary = () => text().searchSummary({ fields: props.search.searchFieldsLabel(), place: placeLabel() });
  const phoneItems = (): DropdownItem[] => [
    {
      sectionLabel: text().searchIn,
      items: props.search.quickSearchFieldOptions().map((option) => ({
        choice: "checkbox" as const,
        label: option.label,
        checked: () => props.search.searchFields().some((field) => field === option.value),
        closeOnSelect: false,
        action: () => {
          const fields: string[] = [...props.search.searchFields()];
          props.search.updateSearchFields(
            fields.includes(option.value) ? fields.filter((field) => field !== option.value) : [...fields, option.value],
          );
        },
      })),
    },
    {
      sectionLabel: text().place,
      items: placeOptions().map((option) => ({
        choice: "radio" as const,
        label: option.label,
        checked: () => (props.search.scopeFolderId() ?? "") === option.value,
        closeOnSelect: false,
        action: () => props.search.updateScope(option.value || null),
      })),
    },
    {
      items: [
        {
          label: text().moreFiltersEllipsis,
          icon: "ti ti-adjustments-search",
          action: () => void props.search.openAdvancedSearch(),
        },
      ],
    },
  ];
  return (
    <span class="contents" data-mail-head-search-options>
      {/* Phones: "Search in" and "Place" share one menu, with the way to more filters. */}
      <Dropdown.Root position="bottom-left" width="18rem" items={phoneItems()} label={text().searchOptions}>
        <Dropdown.Trigger
          appearance="plain"
          class="k2b-filter-chip mail-search-phone-options"
          data-active={!isDefaultQuickSearch(props.search.searchFields()) || props.search.scopeFolderId() ? "true" : undefined}
          label={`${text().searchOptions}: ${summary()}`}
          data-mail-search-phone-options
        >
          <i class="ti ti-adjustments-horizontal" aria-hidden="true" />
          <span class="k2b-filter-chip__label">{summary()}</span>
          <i class="ti ti-chevron-down k2b-filter-chip__chevron" aria-hidden="true" />
        </Dropdown.Trigger>
      </Dropdown.Root>
      <FilterChip
        label={text().searchInValue({ value: props.search.searchFieldsLabel() })}
        icon="ti ti-filter-search"
        options={[{ label: text().searchIn, options: props.search.quickSearchFieldOptions(), multiple: true }]}
        value={props.search.searchFields()}
        defaultValue={[...DEFAULT_MAIL_QUICK_SEARCH_FIELDS]}
        isActive={!isDefaultQuickSearch(props.search.searchFields())}
        onValueChange={props.search.updateSearchFields}
        position="bottom-right"
        class="mail-search-wide-option"
      />
      <FilterChip
        label={text().placeValue({ value: placeLabel() })}
        icon="ti ti-map-pin"
        options={[
          {
            label: text().place,
            options: placeOptions(),
          },
        ]}
        value={[props.search.scopeFolderId() ?? ""]}
        defaultValue={[""]}
        isActive={Boolean(props.search.scopeFolderId())}
        onValueChange={(values) => props.search.updateScope(values[0] || null)}
        class="mail-search-wide-option"
      />
      {/* Wide, More filters is a chip with its name beside the other two; phones reach it in the combined menu. */}
      <FilterToggle
        class="mail-search-advanced mail-search-wide-option"
        label={text().moreFilters}
        icon={props.search.searchBuilderLoading() ? "ti ti-loader-2 animate-spin" : "ti ti-adjustments-search"}
        active={Boolean(props.search.structuredSummary())}
        opensDialog
        busy={props.search.searchBuilderLoading()}
        onClick={() => void props.search.openAdvancedSearch()}
      />
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
