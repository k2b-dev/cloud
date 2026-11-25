import type { HelpDocumentManifest } from "@k2b/cloud/shared";
import type { KeyboardPlatform } from "@k2b/ui";
import type { JSX } from "solid-js";
import type { AppAppearance } from "../contracts/app";
import type { LayoutHelpArticle } from "./help";
import type { HelpStartSection } from "./help-v2/HelpReader";

export type LayoutHelpPanelProps = {
  documents: readonly HelpDocumentManifest[];
  /** Absent when the context selected Help the reader may not see. */
  app?: { id: string; name: string; icon?: string };
  /** appAppearanceStyle() of the app, from the server. */
  appearance?: string;
  /** The selected app's primary colour, even when Core hosts its Help. */
  primary?: AppAppearance["primary"];
  /** Server-filtered For this view ids. */
  view?: readonly string[];
  initialTopic?: string;
  /** Authorized article and server-parsed parts for an identical first frame. */
  initialArticle?: LayoutHelpArticle;
  pageBase?: string;
  platform: KeyboardPlatform;
  state?: "failed" | "unavailable";
  /** A server-rendered section of the provider, placed in the start after the articles and before the shortcuts. */
  startSection?: JSX.Element;
  /**
   * The provider page is built with `@k2b/ui/v2` (its `PanelLayout` has `ui: "v2"`): the reader draws itself from v2
   * primitives. It takes the provider's start part as data in `sections` instead of `startSection`.
   */
  ui?: "v2";
  sections?: readonly HelpStartSection[];
};
