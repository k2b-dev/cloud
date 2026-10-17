import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-messages-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const catalogs = {
  Shortcut: (await import("./shortcut-messages")).checkShortcutMessages,
  TableOfContents: (await import("../layout/table-of-contents-messages")).checkTableOfContentsMessages,
  Ui: (await import("./messages")).checkUiMessages,
  Chart: (await import("../content/chart-messages")).checkChartMessages,
  Chat: (await import("../chat/chat-messages")).checkChatMessages,
  Install: (await import("../feedback/install-messages")).checkInstallMessages,
  Qr: (await import("../inputs/qr-messages")).checkQrMessages,
  Emoji: (await import("../inputs/emoji/emoji-messages")).checkEmojiMessages,
  Signature: (await import("../inputs/signature-messages")).checkSignatureMessages,
  FileBrowser: (await import("../content/file-browser-messages")).checkFileBrowserMessages,
  FileView: (await import("../content/file-view-messages")).checkFileViewMessages,
  FileInput: (await import("../inputs/file-input-messages")).checkFileInputMessages,
  FileDrop: (await import("../inputs/file-drop-messages")).checkFileDropMessages,
  Pdf: (await import("../content/pdf-messages")).checkPdfMessages,
  MarkdownInfoBlock: (await import("../content/markdown-info-block-messages")).checkMarkdownInfoBlockMessages,
  MarkdownReference: (await import("../content/markdown-reference-messages")).checkMarkdownReferenceMessages,
  MarkdownToolbar: (await import("../inputs/markdown/toolbar-messages")).checkMarkdownToolbarMessages,
  MarkdownEditor: (await import("../inputs/markdown/editor-messages")).checkMarkdownEditorMessages,
  Settings: (await import("../layout/settings-messages")).checkSettingsMessages,
  Panes: (await import("../layout/panes-messages")).checkPanesMessages,
  FloatingWindow: (await import("../layout/floating-window-messages")).checkFloatingWindowMessages,
  DataTable: (await import("../content/data-table-messages")).checkDataTableMessages,
  Lightbox: (await import("../content/lightbox-messages")).checkLightboxMessages,
  Prompt: (await import("../feedback/prompt-messages")).checkPromptMessages,
  Calendar: (await import("../content/calendar-messages")).checkCalendarMessages,
  Timeline: (await import("../content/timeline-messages")).checkTimelineMessages,
  Viewport: (await import("../content/viewport-messages")).checkViewportMessages,
  Select: (await import("../inputs/select-messages")).checkSelectMessages,
  Completion: (await import("../inputs/completion-messages")).checkCompletionMessages,
  Tag: (await import("../inputs/tag-messages")).checkTagMessages,
  Input: (await import("../inputs/input-messages")).checkInputMessages,
  Icon: (await import("../inputs/icon-messages")).checkIconMessages,
  Template: (await import("../inputs/template-messages")).checkTemplateMessages,
  Avatar: (await import("../surfaces/avatar-messages")).checkAvatarMessages,
  DetailPanel: (await import("../layout/detail-panel-messages")).checkDetailPanelMessages,
  Resource: (await import("../surfaces/resource-messages")).checkResourceMessages,
  Pagination: (await import("../content/pagination-messages")).checkPaginationMessages,
  StructuredData: (await import("../content/structured-data-messages")).checkStructuredDataMessages,
  LogEntries: (await import("../content/log-entries-messages")).checkLogEntriesMessages,
  Docs: (await import("../content/docs-messages")).checkDocsMessages,
  Workspace: (await import("../layout/workspace-messages")).checkWorkspaceMessages,
  Toast: (await import("../feedback/toast-messages")).checkToastMessages,
  Spotlight: (await import("../actions/spotlight-messages")).checkSpotlightMessages,
  PanelDialog: (await import("../layout/panel-dialog-messages")).checkPanelDialogMessages,
  Toolbar: (await import("../actions/toolbar-messages")).checkToolbarMessages,
  Filter: (await import("../actions/filter-messages")).checkFilterMessages,
  RenderError: (await import("../internal/render-error-messages")).checkRenderErrorMessages,
  Feed: (await import("../content/feed-messages")).checkFeedMessages,
  Video: (await import("../content/video-messages")).checkVideoMessages,
  RangePicker: (await import("../content/range-picker-messages")).checkRangePickerMessages,
  Refresh: (await import("../layout/refresh-messages")).checkRefreshMessages,
};

describe("@k2b/ui message catalogs", () => {
  for (const [family, check] of Object.entries(catalogs)) {
    test(`${family} keeps every shipped locale complete`, () => {
      expect(check()).toEqual([]);
    });
  }
});
