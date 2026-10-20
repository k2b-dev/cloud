import { clipboard } from "@k2b/stdlib/solid";
import { Dropdown, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { helpMessages } from "./help-messages";
import { formatHelpBundleMarkdown, formatHelpDocumentMarkdown } from "./layout-help-markdown";
import { loadPanelDocument } from "./layout-help-panel-document";
import type { HelpPanelState } from "./layout-help-panel-state";
import { layoutHelpTopicHref } from "./layout-help-url";

export type MenuActivation = { key: string; focus: boolean; pointer?: boolean };
export function HelpPanelMenu(props: { state: HelpPanelState; activation: MenuActivation }) {
  const state = props.state;
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  const write = (text: string) => navigator.clipboard.writeText(text);
  const writer = clipboard.createWriter({ write, copiedFor: 1800 });
  const allWriter = clipboard.createWriter({ write, copiedFor: 1800 });
  createEffect(() => state.setAnnouncement(writer.wasCopied() ? t().articleCopiedAnnouncement : ""));
  onCleanup(() => state.setAnnouncement(""));
  const [copying, setCopying] = createSignal(false);
  let controller: AbortController | undefined;
  let trigger: HTMLButtonElement | undefined;
  const topic = () => state.data.documents.find((topic) => topic.id === state.activeId());
  const payload = () => {
    const active = topic();
    return active ? state.cachedDocument(active) : undefined;
  };
  const copyArticle = async () => {
    const active = topic();
    const document = payload();
    if (!active || !document) return;
    // Invoke the clipboard writer before the first await: Safari needs the menu item's user activation.
    if (await writer.copy(formatHelpDocumentMarkdown({ ...active, markdown: document.markdown }))) {
      toast.success(t().articleCopied);
    } else
      toast.error(t().copyFailed({ message: writer.error()?.message ?? t().copyFallback }), {
        action: { label: t().tryAgain, onClick: () => void copyArticle() },
      });
  };
  const copyAll = async () => {
    if (!state.data.documents.length || copying()) return;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setCopying(true);
    const progress = toast(t().preparing, { progress: "indeterminate", duration: 0, iconClass: "ti ti-markdown" });
    try {
      const documents = await Promise.all(
        state.data.documents.map(async (topic) => ({
          ...topic,
          markdown: (await loadPanelDocument(state, topic, current.signal, t())).markdown,
        })),
      );
      if (!(await allWriter.copy(formatHelpBundleMarkdown(documents)))) throw allWriter.error() ?? new Error(t().copyFallback);
      progress.dismiss();
      toast.success(t().helpCopied);
    } catch (error) {
      progress.dismiss();
      if (!(error instanceof DOMException && error.name === "AbortError"))
        toast.error(t().copyAllFailed({ message: error instanceof Error ? error.message : t().copyFallback }), {
          action: { label: t().tryAgain, onClick: () => void copyAll() },
        });
    } finally {
      if (controller === current) {
        controller = undefined;
        setCopying(false);
      }
    }
  };
  const [quiet, setQuiet] = createSignal(!!props.activation.pointer);
  onCleanup(() => controller?.abort());
  onMount(() => {
    if (props.activation.focus) trigger?.focus({ preventScroll: true });
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: props.activation.key, bubbles: true, cancelable: true }));
  });
  const items = () => [
    {
      label: t().copyAsMarkdown,
      icon: "ti ti-markdown",
      ...(copying() || (state.view() === "article" ? !payload() : !state.data.documents.length)
        ? { disabled: true as const }
        : { action: () => void (state.view() === "article" ? copyArticle() : copyAll()) }),
    },
    ...(state.data.pageBase
      ? [
          {
            label: t().openAsPage,
            icon: "ti ti-app-window",
            href: layoutHelpTopicHref(state.data.pageBase, state.view() === "article" ? state.activeId() : null),
          },
        ]
      : []),
  ];
  return (
    <Dropdown.Root label={t().moreActions} position="bottom-left" items={items()}>
      <Dropdown.Trigger
        ref={(element) => {
          trigger = element;
        }}
        iconOnly
        label={t().moreActions}
        variant="ghost"
        data-help-menu=""
        // A press on the light trigger counts as a press here: like Dropdown.Trigger's own, its hint stays closed until
        // the pointer leaves.
        tooltip={quiet() ? false : undefined}
        onPointerLeave={() => setQuiet(false)}
      >
        <i class="ti ti-dots" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
