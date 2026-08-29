import { TextInput, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onMount } from "solid-js";
import { platformMessages } from "../platform-messages";

type SearchBarProps = {
  action?: string;
  value?: string;
  param?: string;
  pageParam?: string;
  placeholder?: string;
  ariaLabel?: string;
};

/** Search bar that filters content via URL query parameter. */
export default function SearchBar(props: SearchBarProps = {}) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const param = props.param ?? "search";
  const pageParam = props.pageParam ?? "page";
  const [query, setQuery] = createSignal(props.value ?? "");

  createEffect(() => {
    if (props.value !== undefined) {
      setQuery(props.value);
    }
  });

  onMount(() => {
    if (props.value !== undefined) return;
    const fallback = new URLSearchParams(window.location.search).get(param) ?? "";
    setQuery(fallback);
  });

  const handleSubmit = (e: Event): void => {
    e.preventDefault();
    const current = new URL(window.location.href);
    const url = props.action ? new URL(props.action, window.location.origin) : current;
    const value = query().trim();

    if (value.length > 0) {
      url.searchParams.set(param, value);
    } else {
      url.searchParams.delete(param);
    }
    url.searchParams.delete(pageParam);

    window.location.href = url.toString();
  };

  const handleClear = (): void => {
    const current = new URL(window.location.href);
    const url = props.action ? new URL(props.action, window.location.origin) : current;

    url.searchParams.delete(param);
    url.searchParams.delete(pageParam);

    window.location.href = url.toString();
  };

  return (
    <form onSubmit={handleSubmit} role="search" class="w-full">
      <TextInput
        name={param}
        type="search"
        placeholder={props.placeholder ?? `${t().search}…`}
        aria-label={props.ariaLabel ?? t().search}
        icon="ti ti-search"
        activeIcon="ti ti-search"
        value={query}
        onValueChange={setQuery}
        clearable
        clearLabel={t().clearSearch}
        onClear={handleClear}
      />
      <button type="submit" class="hidden">
        {t().search}
      </button>
    </form>
  );
}
