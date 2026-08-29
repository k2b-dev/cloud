import { Button, Dropdown, type DropdownItem, TextInput, useLocale } from "@k2b/ui";
import type { Accessor, Setter } from "solid-js";
import { Show } from "solid-js";
import { documentMessages } from "./messages";

type ViewMode = "list" | "folders";

type Props = {
  canWrite: boolean;
  searchDraft: Accessor<string>;
  setSearchDraft: Setter<string>;
  clearSearch: () => void;
  activeMode: "list" | "folders";
  searching: boolean;
  countLabel: string;
  onGenerate: () => void;
  onMode: (mode: ViewMode) => void;
};

export default function DocumentBrowserToolbar(props: Props) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const activeLabel = () => (props.activeMode === "folders" ? t().folders : t().table);
  const activeIcon = () => (props.activeMode === "folders" ? "ti ti-folder" : "ti ti-table");
  const modeItems = (): DropdownItem[] => [
    { icon: "ti ti-table", label: t().table, action: () => props.onMode("list") },
    props.searching
      ? {
          icon: "ti ti-folder",
          label: t().folders,
          description: t().unavailableWhileSearching,
          disabled: true,
        }
      : { icon: "ti ti-folder", label: t().folders, action: () => props.onMode("folders") },
  ];

  return (
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <Show when={props.canWrite}>
        <Button variant="primary" size="sm" type="button" onClick={props.onGenerate}>
          <i class="ti ti-plus" />
          {t().addNew}
        </Button>
      </Show>
      <div class="min-w-64 flex-1">
        <TextInput
          type="search"
          aria-label={t().searchDocuments}
          icon="ti ti-search"
          placeholder={t().searchDocumentsPlaceholder}
          value={props.searchDraft}
          onValueChange={props.setSearchDraft}
          clearable
          onClear={props.clearSearch}
        />
      </div>
      <Dropdown.Root position="bottom-left" items={modeItems()}>
        <Dropdown.Trigger variant="secondary" size="sm">
          <i class={activeIcon()} />
          {activeLabel()}
          <i class="ti ti-chevron-down text-[10px] opacity-60" />
        </Dropdown.Trigger>
      </Dropdown.Root>
      <span class="whitespace-nowrap text-xs text-dimmed">{props.countLabel}</span>
    </div>
  );
}
