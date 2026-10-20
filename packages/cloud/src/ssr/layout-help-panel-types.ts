import type { HelpDocumentManifest } from "@k2b/cloud/shared";
import type { KeyboardPlatform } from "@k2b/ui";
import type { LayoutHelpArticle } from "./help";

export type LayoutHelpPanelProps = {
  documents: readonly HelpDocumentManifest[];
  /** Absent when the context selected Help the reader may not see. */
  app?: { id: string; name: string; icon?: string };
  /** appAppearanceStyle() of the app, from the server. */
  appearance?: string;
  /** Server-filtered For this view ids. */
  view?: readonly string[];
  initialTopic?: string;
  /** Authorized article and server-parsed parts for an identical first frame. */
  initialArticle?: LayoutHelpArticle;
  pageBase?: string;
  platform: KeyboardPlatform;
  state?: "failed" | "unavailable";
};
