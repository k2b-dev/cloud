import { onCleanup, onMount } from "solid-js";

/** A real column island deliberately using raw history, to exercise install order. */
export default function Column(props: { page: string; historyProbe?: boolean }) {
  onMount(() => {
    const raw = () => {
      document.documentElement.dataset.rawPops = String(Number(document.documentElement.dataset.rawPops ?? 0) + 1);
    };
    window.addEventListener("popstate", raw);
    onCleanup(() => window.removeEventListener("popstate", raw));
    if (props.historyProbe) history.pushState({ fixtureColumn: true }, "", `${location.pathname}?entry=column`);
    document.documentElement.dataset.columnMounted = props.page;
  });
  return <output data-column-mounted>{props.page}</output>;
}
