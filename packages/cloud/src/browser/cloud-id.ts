import { i18n } from "@k2b/stdlib";
import { type DropdownItem, toast, useLocale } from "@k2b/ui";
import { createMemo, onMount } from "solid-js";
import type { CloudResourceRef } from "../contracts/capabilities";
import { cloudResourceHref } from "../contracts/resource-href";
import { cloudOrigin } from "./resource-links";

export const cloudIdMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      copy: "Copy Cloud ID",
      copied: "Cloud ID copied",
      copyFailed: "Could not copy the Cloud ID",
    },
    de: {
      copy: "Cloud-ID kopieren",
      copied: "Cloud-ID kopiert",
      copyFailed: "Cloud-ID konnte nicht kopiert werden",
    },
  },
});

type ClipboardModule = typeof import("./resource-clipboard");
// The clipboard contract validates with Zod, which stays out of an island's first load. It loads once the page is
// idle, so a copy usually writes the structured reference inside the click that asked for it.
let clipboardModule: ClipboardModule | undefined;
const loadClipboard = () => import("./resource-clipboard").then((module) => (clipboardModule = module));

/** One entry of the menu; `label` names the resource when a menu offers several, such as a message and its conversation. */
export type CloudIdTarget = { ref: CloudResourceRef; label?: string };

/**
 * "Copy Cloud ID" for the "…" menu of a resource. It copies the structured reference and its `/open` permalink as
 * text: Cloud paste surfaces recognize the resource, and anywhere else the text opens it after sign-in. Without a
 * configured Cloud URL the menu shows nothing.
 */
export const useCloudIdCopy = () => {
  const locale = useLocale();
  const t = createMemo(() => cloudIdMessages.resolve([locale()]).t);
  onMount(() => {
    if (clipboardModule || !cloudOrigin()) return;
    const warm = () => void loadClipboard().catch(() => undefined);
    if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 2000 });
    else setTimeout(warm, 0);
  });

  const copy = (ref: CloudResourceRef) => {
    const cloudUrl = cloudOrigin();
    if (!cloudUrl) return;
    const failed = () => void toast.error(t().copyFailed);
    const write = (module: ClipboardModule) => {
      try {
        const { cloudResourceClipboard } = module;
        return cloudResourceClipboard
          .write({ cloudUrl, ref, fallbackText: cloudResourceClipboard.url(ref, cloudUrl) })
          .then(() => void toast.success(t().copied), failed);
      } catch {
        failed();
      }
    };
    if (clipboardModule) return void write(clipboardModule);
    // Before the clipboard code loads, copy the permalink alone: WebKit allows a write only while the click is handled.
    try {
      void navigator.clipboard.writeText(new URL(cloudResourceHref(ref), cloudUrl).href).then(() => void toast.success(t().copied), failed);
    } catch {
      failed();
    }
    void loadClipboard().catch(() => undefined);
  };

  return {
    available: () => Boolean(cloudOrigin()),
    copy,
    /** The last section of a resource's "…" menu; empty without a resource or a configured Cloud URL. */
    section: (...targets: readonly (CloudResourceRef | CloudIdTarget | null | undefined | false)[]): DropdownItem[] => {
      if (!cloudOrigin()) return [];
      const items = targets.flatMap((target) => {
        if (!target) return [];
        const { ref, label } = "ref" in target ? target : { ref: target, label: undefined };
        return [{ label: label ?? t().copy, icon: "ti ti-id", immediate: true, action: () => copy(ref) }];
      });
      return items.length > 0 ? [{ items }] : [];
    },
  };
};
