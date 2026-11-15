import { IconButton } from "@k2b/ui";

/**
 * The sign a narrow island shows in place of its table's search (Feinschliff v3 §5). Opened, the search lies over the
 * title up to this sign, which keeps its place unseen: the title keeps its width and the head its height. The head
 * learns how far the search may reach from its right edge (`--cloud-search-end`), and the search takes the focus.
 */
export function SearchToggle(props: { label: string; disabled?: boolean; onOpen?: () => void }) {
  return (
    <IconButton
      class="cloud-table-search-toggle"
      size="sm"
      variant="ghost"
      label={props.label}
      disabled={props.disabled}
      onClick={(event) => {
        const sign = event.currentTarget;
        const head = sign.closest<HTMLElement>(".k2b-dashboard-frame__header, .cloud-view-heading");
        if (head)
          head.style.setProperty("--cloud-search-end", `${head.getBoundingClientRect().right - sign.getBoundingClientRect().right}px`);
        props.onOpen?.();
        head?.querySelector<HTMLInputElement>("input[type=search]")?.focus();
      }}
    >
      <i class="ti ti-search" aria-hidden="true" />
    </IconButton>
  );
}
