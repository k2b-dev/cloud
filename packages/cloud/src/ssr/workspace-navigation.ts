import { createNavigation, type NavigationController, type NavigationItem } from "@k2b/ui";
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
      return (entry.children === undefined || validItems(entry.children)) && (entry.actions === undefined || validItems(entry.actions));
    })
  );
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
    // SSR links work before the app island loads; action handlers are not yet available.
    const links = (items: readonly NavigationItem[]): NavigationItem[] =>
      items.map((item) => ({
        ...item,
        disabled: item.disabled || Boolean(item.action && !item.href),
        ...(item.href ? { action: undefined } : {}),
        ...(item.children ? { children: links(item.children) } : {}),
        ...(item.actions ? { actions: links(item.actions) } : {}),
      }));
    const items = links(value.items);
    return {
      owner,
      label: "label" in value && typeof value.label === "string" ? value.label : "",
      navigation: createNavigation({ items: () => items }),
    };
  } catch {
    return;
  }
}

export function observeWorkspaceNavigation(listener: () => void) {
  window.addEventListener(changedEvent, listener);
  return () => window.removeEventListener(changedEvent, listener);
}
