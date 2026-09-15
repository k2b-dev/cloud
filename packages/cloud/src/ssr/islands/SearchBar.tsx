import { IconButtonLink, TextInput, useLocale } from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import { platformMessages } from "../platform-messages";

type SearchBarProps = {
  /** Destination URL including every filter to retain. */
  action: string;
  value?: string;
  param?: string;
  pageParam?: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
};

/** Native GET search: works in server HTML and inside hydrated islands. */
export default function SearchBar(props: SearchBarProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const param = () => props.param ?? "search";
  const target = createMemo(() => {
    // Split without resolving against a browser-only origin; relative URLs stay relative.
    const hashAt = props.action.indexOf("#");
    const hash = hashAt < 0 ? "" : props.action.slice(hashAt);
    const href = hashAt < 0 ? props.action : props.action.slice(0, hashAt);
    const queryAt = href.indexOf("?");
    const path = queryAt < 0 ? href : href.slice(0, queryAt);
    const params = new URLSearchParams(queryAt < 0 ? "" : href.slice(queryAt + 1));
    const value = props.value ?? params.get(param()) ?? "";
    params.delete(param());
    params.delete(props.pageParam ?? "page");
    const query = params.toString();
    return { action: path + hash, clear: path + (query || !path ? `?${query}` : "") + hash, fields: [...params], value };
  });

  return (
    <form action={target().action} method="get" role="search" class="group/search w-full">
      <For each={target().fields}>{([name, value]) => <input type="hidden" name={name} value={value} />}</For>
      <TextInput
        name={param()}
        type="search"
        placeholder={props.placeholder || `${t().search}…`}
        aria-label={props.ariaLabel ?? t().search}
        icon="ti ti-search"
        activeIcon="ti ti-search"
        value={() => target().value}
        disabled={props.disabled}
        suffix={
          <Show when={!props.disabled}>
            <IconButtonLink
              href={target().clear}
              label={t().clearSearch}
              size="xs"
              tooltip={false}
              class="group-has-[input:placeholder-shown]/search:invisible"
            >
              <i class="ti ti-x" aria-hidden="true" />
            </IconButtonLink>
          </Show>
        }
      />
      <button type="submit" class="hidden" disabled={props.disabled}>
        {t().search}
      </button>
    </form>
  );
}
