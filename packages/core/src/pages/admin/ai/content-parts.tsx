import { navigateTo } from "@k2b/ssr/nav";
import { Button, Input } from "@k2b/ui/v2";
import { Show } from "solid-js";
import { AI_AREA_PATH } from "./area";
import type { AiContentMessages } from "./content-messages";

/** Where a list of the AI area's shared content stands: its section, search, page and the open entry. */
export type ContentAddress = { sec: "skills" | "projects"; search: string; page: number; open?: string | null };

/** The address of a list place; the open entry's key is `skill` or `project`, page 1 and an empty search stay out. */
export const contentHref = (address: ContentAddress): string => {
  const params = new URLSearchParams({ sec: address.sec });
  if (address.search) params.set("search", address.search);
  if (address.page > 1) params.set("page", String(address.page));
  if (address.open) params.set(address.sec === "skills" ? "skill" : "project", address.open);
  return `${AI_AREA_PATH}?${params}`;
};

/**
 * The list's search in the head. Enter sends `search` with the section also without JavaScript (a GET form); where the
 * island runs it loads the first page of the matches. Escape in a filled field shows everything again.
 */
export const ContentSearch = (props: { address: ContentAddress; label: string; placeholder: string }) => {
  const search = (text: string) => navigateTo(contentHref({ sec: props.address.sec, search: text.trim(), page: 1 }));
  return (
    <Input
      type="search"
      icon="search"
      name="search"
      label={props.label}
      placeholder={props.placeholder}
      value={props.address.search}
      send={{ action: AI_AREA_PATH, params: [["sec", props.address.sec]], onSearch: search }}
      onKeyDown={(event) => {
        if (event.isComposing) return;
        const input = event.currentTarget as HTMLInputElement;
        if (event.key === "Escape" && input.value) {
          input.value = "";
          search("");
        }
      }}
    />
  );
};

/**
 * Earlier and later pages of a list longer than one page, at the end of its status row. k2b-ui gap: v2 has no pager;
 * two quiet buttons that lead to the neighbouring pages stand in, and the page count is a fact of the row.
 */
export const ContentPager = (props: { address: ContentAddress; pages: number; t: AiContentMessages }) => (
  <Show when={props.pages > 1}>
    <Button
      variant="ghost"
      icon="chevron-left"
      label={props.t.previousPage}
      disabled={props.address.page <= 1}
      href={props.address.page > 1 ? contentHref({ ...props.address, open: null, page: props.address.page - 1 }) : undefined}
    />
    <Button
      variant="ghost"
      icon="chevron-right"
      label={props.t.nextPage}
      disabled={props.address.page >= props.pages}
      href={props.address.page < props.pages ? contentHref({ ...props.address, open: null, page: props.address.page + 1 }) : undefined}
    />
  </Show>
);
