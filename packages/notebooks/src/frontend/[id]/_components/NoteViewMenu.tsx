import { useLocale, watchAppHostWidth } from "@k2b/ui";
import { Menu, type MenuEntry } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { notebookWorkspaceMessages } from "../messages";
import { RICH_MODE_CHANGED_EVENT, TOGGLE_RICH_MODE_EVENT } from "./detail/events";
import { changeFullWidth, createFullWidth } from "./full-width";

/**
 * "Ansicht" in the head of a note: how the editor shows its text (Write only) and the personal full-width preference,
 * which a host narrower than 64 rem does not offer (the column fills it anyway). The views themselves are the head's
 * tabs.
 */
export default function NoteViewMenu(props: {
  mode: "edit" | "read";
  /** The server's full-width cookie value, so the first frame matches. */
  fullWidth: boolean;
  initialRich: boolean;
  /** The element inside the app host whose width decides whether full width is offered. */
  host: () => Element | null | undefined;
}) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const fullWidth = createFullWidth(props.fullWidth);
  const [rich, setRich] = createSignal(props.initialRich);
  const [wide, setWide] = createSignal(false);
  onMount(() => {
    const host = props.host();
    if (host instanceof HTMLElement) onCleanup(watchAppHostWidth(host, 64, setWide));
    const onRich = (event: Event) => setRich((event as CustomEvent<{ isRich: boolean }>).detail.isRich);
    window.addEventListener(RICH_MODE_CHANGED_EVENT, onRich);
    onCleanup(() => window.removeEventListener(RICH_MODE_CHANGED_EVENT, onRich));
  });
  const items = (): MenuEntry[] => [
    ...(props.mode === "edit"
      ? [
          {
            title: t().textView,
            choice: rich() ? "rich" : "source",
            onChoose: (value: string) => {
              if ((value === "rich") !== rich()) window.dispatchEvent(new CustomEvent(TOGGLE_RICH_MODE_EVENT));
            },
            items: [
              { label: t().formattedText, icon: "typography", value: "rich" },
              { label: t().markdownText, icon: "markdown", value: "source" },
            ],
          },
        ]
      : []),
    ...(wide()
      ? [{ label: t().fullWidth, meta: t().fullWidthHint, checked: fullWidth(), onClick: () => changeFullWidth(!fullWidth()) }]
      : []),
  ];
  return (
    <Show when={items().length > 0}>
      <Menu label={t().view} icon="adjustments-horizontal" items={items()}>
        {t().view}
      </Menu>
    </Show>
  );
}
