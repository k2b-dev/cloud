import { query } from "@k2b/stdlib/solid";
import { type DialogRender, dialogCore, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, onMount } from "solid-js";
import type { SearchItem } from "../api/search/schemas";
import CloudResourceSearch from "../browser/CloudResourceSearch";
import { COMMANDS_CHANGED, collectContextAwareCommands } from "../browser/command-bridge";
import { contextCommandsWithShortcuts } from "../browser/command-shortcuts";
import { openCommand, runContextAwareCommand } from "../browser/commands";
import type { NavigationSearchItem } from "../browser/navigation-search";
import { resourceSearchDialogOptions } from "../browser/resource-search-dialog";
import { resourceSearchMessages } from "../browser/resource-search-messages";
import { type GlobalSearchOptions, requestSearchNavigation } from "../browser/search-bridge";
import { loadSearchCommands, type PaletteCommand } from "../browser/search-commands";
import { attachSpotlightPosition } from "../browser/spotlight-position";
import { resolveCommand } from "../capabilities/client";

type GlobalSearchDialogProps = {
  request?: GlobalSearchOptions;
  close: () => void;
  context?: Parameters<DialogRender<void>>[1];
  searchLinks?: NavigationSearchItem[];
  searchResources?: boolean;
};

export default function GlobalSearchDialog(props: GlobalSearchDialogProps) {
  const locale = useLocale();
  const messages = () => resourceSearchMessages.resolve([locale()]).t;
  const [contextCommands, setContextCommands] = createSignal<PaletteCommand[]>([]);
  const updateContextCommands = () => setContextCommands(contextCommandsWithShortcuts().map((command) => ({ ...command, context: true })));
  const commandsQuery = query.create({
    source: locale,
    enabled: () => props.searchResources !== false,
    load: (locale, { abortSignal }) => loadSearchCommands(locale, abortSignal),
  });
  onMount(() => {
    window.addEventListener(COMMANDS_CHANGED, updateContextCommands);
    updateContextCommands();
    onCleanup(() => window.removeEventListener(COMMANDS_CHANGED, updateContextCommands));
  });
  const runCommand = async (command: PaletteCommand, newTab: boolean) => {
    if (navigating()) return;
    // Check live ownership once more; a background panel may have closed since rendering.
    if (
      command.context &&
      !collectContextAwareCommands().some((current) => current.id === command.id && current.action === command.action)
    ) {
      updateContextCommands();
      toast.error(messages().commandUnavailable);
      return;
    }
    const target = command.action;
    if (typeof target !== "function" && "search" in target) {
      if (!newTab) await runContextAwareCommand(command);
      return;
    }
    setNavigating(true);
    setNavigationError(false);
    if (newTab && typeof target !== "function") {
      // Reserve synchronously inside the user gesture; never lose it to popup blocking.
      const tab = window.open("about:blank", "_blank");
      if (tab) tab.opener = null;
      try {
        if (!tab) throw new Error("Popup blocked");
        const result = await resolveCommand(target.command, target.input, target.options);
        if (!result.ok) throw new Error(result.error.message);
        tab.location.replace(result.data.href);
      } catch {
        tab?.close();
        if (active) setNavigationError(true);
      } finally {
        if (active) setNavigating(false);
      }
      return;
    }
    props.close();
    try {
      if (command.context) await runContextAwareCommand(command);
      else if (typeof target === "function") await target();
      else await openCommand(target.command, target.input, target.options);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : messages().commandFailed);
    }
  };
  let host!: HTMLDivElement;
  onMount(() => {
    if (props.context) onCleanup(attachSpotlightPosition(host, props.context, messages));
  });
  const openInNewTab = (item: SearchItem) => {
    window.open(item.href, "_blank", "noopener,noreferrer");
  };
  const [navigating, setNavigating] = createSignal(false);
  const [navigationError, setNavigationError] = createSignal(false);
  createEffect(() => {
    props.request;
    setNavigationError(false);
  });
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const openItem = async (item: SearchItem) => {
    if (navigating()) return;
    setNavigating(true);
    setNavigationError(false);
    try {
      const handled = await requestSearchNavigation({
        href: item.href,
        ...(item.ref.type === "cloud.navigation" ? {} : { ref: item.ref }),
      });
      if (!active) return;
      props.close();
      if (!handled) window.location.assign(item.href);
    } catch {
      if (active) setNavigationError(true);
    } finally {
      if (active) setNavigating(false);
    }
  };
  return (
    <div ref={host} class="cloud-global-search">
      <CloudResourceSearch
        commands={[
          ...contextCommands(),
          ...(commandsQuery.data() ?? []).filter((command) => !contextCommands().some((context) => context.id === command.id)),
        ]}
        commandsLoading={commandsQuery.loading()}
        commandsError={Boolean(commandsQuery.error())}
        onCommand={props.searchResources === false ? undefined : (command, newTab) => void runCommand(command, newTab)}
        request={props.request}
        disabled={navigating()}
        navigationError={navigationError() ? messages().navigationFailed : undefined}
        navigationItems={props.searchLinks}
        searchResources={props.searchResources}
        onClose={props.close}
        onSelect={(item) => void openItem(item)}
        onOpenInNewTab={openInNewTab}
      />
      <For each={["top", "right", "bottom", "left"]}>{(edge) => <div aria-hidden="true" data-search-grip={edge} />}</For>
    </div>
  );
}

/** Owned by the layout island; neither dialog state nor callbacks cross SSR props. */
export const createGlobalSearchHost = (searchLinks: () => NavigationSearchItem[], searchResources = true) => {
  const [request, setRequest] = createSignal<GlobalSearchOptions>({});
  let controller: AbortController | undefined;
  return {
    open: (options: GlobalSearchOptions) => {
      setRequest({ ...options });
      if (controller) {
        document.querySelector<HTMLInputElement>(".cloud-global-search input[role=combobox]")?.focus();
        return;
      }
      const current = new AbortController();
      controller = current;
      const locale = document.documentElement.lang || "en";
      void dialogCore
        .open<void>(
          (close, context) => (
            <GlobalSearchDialog
              request={request()}
              searchLinks={searchLinks()}
              searchResources={searchResources}
              close={close}
              context={context}
            />
          ),
          { ...resourceSearchDialogOptions(resourceSearchMessages.resolve([locale]).t.searchCloudResources), signal: current.signal },
        )
        .catch(() => {
          toast.error(resourceSearchMessages.resolve([locale]).t.searchFailed);
        })
        .finally(() => {
          if (controller === current) controller = undefined;
        });
    },
    dispose: () => {
      controller?.abort();
      controller = undefined;
    },
  };
};
