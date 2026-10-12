import { type AppWorkspaceSidebarSwitcherProps, createNavigation, type NavigationController, type NavigationItem } from "@k2b/ui";
import { createEffect, onCleanup, onMount } from "solid-js";

export type WorkspaceNavigationState = { navigation: NavigationController; label: string; owner: Element };
const changedEvent = "cloud:workspace-navigation";

declare global {
  interface Window {
    __cloudWorkspaceNavigation?: WorkspaceNavigationState;
  }
}

/** Bind only the outer application's navigation. Nested workspaces do not register. */
export function provideWorkspaceNavigation(navigation: NavigationController, options: { label: () => string; owner: () => Element }) {
  onMount(() => {
    const state = { navigation, label: options.label(), owner: options.owner() };
    window.__cloudWorkspaceNavigation = state;
    createEffect(() => {
      navigation.items();
      state.label = options.label();
      window.dispatchEvent(new Event(changedEvent));
    });
    onCleanup(() => {
      if (window.__cloudWorkspaceNavigation !== state) return;
      delete window.__cloudWorkspaceNavigation;
      window.dispatchEvent(new Event(changedEvent));
    });
  });
}

function validItems(value: unknown): value is NavigationItem[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.label !== "string") return false;
      if (entry.href !== undefined && typeof entry.href !== "string") return false;
      if (entry.action !== undefined && typeof entry.action !== "string") return false;
      return (
        (entry.children === undefined || validItems(entry.children)) &&
        (entry.actions === undefined || validItems(entry.actions)) &&
        (entry.inlineActions === undefined || validItems(entry.inlineActions))
      );
    })
  );
}

function readSwitcher(value: unknown): AppWorkspaceSidebarSwitcherProps | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("currentId" in value) ||
    typeof value.currentId !== "string" ||
    !("label" in value) ||
    typeof value.label !== "string" ||
    !("icon" in value) ||
    typeof value.icon !== "string" ||
    !("switchLabel" in value) ||
    typeof value.switchLabel !== "string"
  )
    return;
  const description = "description" in value ? value.description : undefined;
  const color = "color" in value ? value.color : undefined;
  if (description !== undefined && typeof description !== "string") return;
  if (color !== undefined && typeof color !== "string") return;
  // The snapshot carries only the head; options and actions wait for the owning island.
  return { currentId: value.currentId, label: value.label, icon: value.icon, switchLabel: value.switchLabel, description, color };
}

export function readWorkspaceNavigation(): WorkspaceNavigationState | undefined {
  if (typeof window === "undefined") return;
  const current = window.__cloudWorkspaceNavigation;
  if (current?.owner.isConnected) return current;
  const owner = document.querySelector<HTMLScriptElement>("script[data-cloud-workspace-navigation]");
  if (!owner) return;
  try {
    const value: unknown = JSON.parse(owner.textContent ?? "");
    if (!value || typeof value !== "object" || !("items" in value) || !validItems(value.items)) return;
    // SSR links work before the app island loads; action and disclosure handlers are not yet available,
    // so the owner's folds only set where the local disclosure starts.
    const links = (items: readonly NavigationItem[]): NavigationItem[] =>
      items.map((item) => ({
        ...item,
        disabled: item.disabled || Boolean(item.action && !item.href),
        ...(item.href ? { action: undefined } : {}),
        ...(item.expanded !== undefined ? { expanded: undefined, defaultExpanded: item.expanded } : {}),
        ...(item.children ? { children: links(item.children) } : {}),
        ...(item.actions ? { actions: links(item.actions) } : {}),
        // Inline actions only run actions, so each waits for the owner.
        ...(item.inlineActions ? { inlineActions: item.inlineActions.map((action) => ({ ...action, disabled: true })) } : {}),
      }));
    const items = links(value.items);
    const switcher = "switcher" in value ? readSwitcher(value.switcher) : undefined;
    return {
      owner,
      label: "label" in value && typeof value.label === "string" ? value.label : "",
      navigation: createNavigation({ items: () => items, ...(switcher ? { switcher: () => switcher } : {}) }),
    };
  } catch {
    return;
  }
}

export function observeWorkspaceNavigation(listener: () => void) {
  window.addEventListener(changedEvent, listener);
  return () => window.removeEventListener(changedEvent, listener);
}
