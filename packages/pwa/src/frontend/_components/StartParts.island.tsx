import { appPartSummaryText, watchAppBadges } from "@k2b/cloud/ssr/app-badges";
import { createNavigation, Navigation } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";

export type StartPart = {
  id: string;
  label: string;
  icon: string;
  href: string;
  /** The part's description when it has no live summary. */
  description?: string;
  /** The part's `pwa.summary` route. */
  summary?: string;
};

export type StartPartsProps = {
  parts: StartPart[];
  label: string;
  /** Every count and summary route of the page; the first reader on a page reads them all. */
  endpoints: string[];
};

/** Start's list of parts. Each row says what waits there, such as "3 unread", once the part has answered. */
export default function StartParts(props: StartPartsProps) {
  let root: HTMLDivElement | undefined;
  onMount(() => {
    // Mark only live summary rows before their first asynchronous answer arrives.
    const summaries = new Set(props.parts.filter((part) => part.summary).map((part) => part.href));
    for (const link of root?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? [])
      if (summaries.has(link.getAttribute("href") ?? "")) link.dataset.pwaSummary = "";
    onCleanup(watchAppBadges(props.endpoints));
  });
  const apps = createNavigation({
    items: () =>
      props.parts.map((part) => ({
        id: part.id,
        label: part.label,
        icon: part.icon,
        href: part.href,
        // Keep one summary line in SSR and the first client render; live text fills it without changing row height.
        description: part.summary ? (appPartSummaryText(part.summary) ?? "\u00a0") : part.description,
      })),
  });
  return (
    <div ref={root}>
      <Navigation navigation={apps} label={props.label} />
    </div>
  );
}
