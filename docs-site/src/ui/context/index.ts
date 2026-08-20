import actionButtons from "./actions/buttons.md" with { type: "text" };
import actionCopyRemove from "./actions/copy-remove.md" with { type: "text" };
import actionDisclosure from "./actions/disclosure.md" with { type: "text" };
import actionMenus from "./actions/menus.md" with { type: "text" };
import actionSegmentedControl from "./actions/segmented-control.md" with { type: "text" };
import actionSpotlight from "./actions/spotlight.md" with { type: "text" };
import actionTabs from "./actions/tabs.md" with { type: "text" };
import actionToolbar from "./actions/toolbar.md" with { type: "text" };
import aiChat from "./ai/chat.md" with { type: "text" };
import aiContextUsage from "./ai/context-usage.md" with { type: "text" };
import cloudAssistantChat from "./cloud/assistant-chat.md" with { type: "text" };
import cloudDashboardWidgets from "./cloud/dashboard-widgets.md" with { type: "text" };
import cloudResourcePicker from "./cloud/resource-picker.md" with { type: "text" };
import contentCharts from "./content/charts.md" with { type: "text" };
import contentCode from "./content/code.md" with { type: "text" };
import contentDocs from "./content/docs.md" with { type: "text" };
import contentFiles from "./content/files.md" with { type: "text" };
import contentLogs from "./content/logs.md" with { type: "text" };
import contentMarkdown from "./content/markdown.md" with { type: "text" };
import contentMedia from "./content/media.md" with { type: "text" };
import contentStructuredData from "./content/structured-data.md" with { type: "text" };
import contentTables from "./content/tables.md" with { type: "text" };
import contentTemplateEditor from "./content/template-editor.md" with { type: "text" };
import feedbackBadges from "./feedback/badges.md" with { type: "text" };
import feedbackBlocks from "./feedback/blocks.md" with { type: "text" };
import feedbackPrompts from "./feedback/prompts.md" with { type: "text" };
import feedbackToast from "./feedback/toast.md" with { type: "text" };
import feedbackTooltip from "./feedback/tooltip.md" with { type: "text" };
import actionFilters from "./filter-chip.md" with { type: "text" };
import inputAutocomplete from "./input/autocomplete.md" with { type: "text" };
import inputBoolean from "./input/boolean.md" with { type: "text" };
import inputColor from "./input/color.md" with { type: "text" };
import inputCombobox from "./input/combobox.md" with { type: "text" };
import inputDatePicker from "./input/date-picker.md" with { type: "text" };
import inputFileDropzone from "./input/file-dropzone.md" with { type: "text" };
import inputIcon from "./input/icon.md" with { type: "text" };
import inputImage from "./input/image.md" with { type: "text" };
import inputImageCropper from "./input/image-cropper.md" with { type: "text" };
import inputNumber from "./input/number.md" with { type: "text" };
import inputPin from "./input/pin.md" with { type: "text" };
import inputSelect from "./input/select.md" with { type: "text" };
import inputSlider from "./input/slider.md" with { type: "text" };
import inputTagEditor from "./input/tag-editor.md" with { type: "text" };
import inputTags from "./input/tags.md" with { type: "text" };
import inputText from "./input/text.md" with { type: "text" };
import layoutDetailPanel from "./layout/detail-panel.md" with { type: "text" };
import layoutDiscussion from "./layout/discussion.md" with { type: "text" };
import layoutFloatingWindow from "./layout/floating-window.md" with { type: "text" };
import layoutOverview from "./layout/overview.md" with { type: "text" };
import contentPagination from "./layout/pagination.md" with { type: "text" };
import layoutPanelDialog from "./layout/panel-dialog.md" with { type: "text" };
import layoutPanes from "./layout/panes.md" with { type: "text" };
import layoutPermissions from "./layout/permissions.md" with { type: "text" };
import layoutScrollArea from "./layout/scroll-area.md" with { type: "text" };
import layoutSettingsModal from "./layout/settings-modal.md" with { type: "text" };
import layoutWorkspace from "./layout/workspace.md" with { type: "text" };
import inputMarkdownEditor from "./markdown-editor.md" with { type: "text" };
import contentCalendar from "./surfaces/calendar.md" with { type: "text" };
import surfaceCards from "./surfaces/cards.md" with { type: "text" };
import surfaceDetails from "./surfaces/details.md" with { type: "text" };
import surfaceEmptyStates from "./surfaces/empty-states.md" with { type: "text" };
import surfaceObservability from "./surfaces/observability.md" with { type: "text" };
import surfacePaper from "./surfaces/paper.md" with { type: "text" };
import surfaceProgress from "./surfaces/progress.md" with { type: "text" };
import surfaceStats from "./surfaces/stats.md" with { type: "text" };
import surfaceUtilities from "./surfaces/utilities.md" with { type: "text" };
import widgetDashboard from "./widgets/dashboard.md" with { type: "text" };

const catalogContextSources = {
  "ai/chat": { file: "ai/chat.md", content: aiChat },
  "ai/context-usage": { file: "ai/context-usage.md", content: aiContextUsage },
  "input/text": { file: "input/text.md", content: inputText },
  "input/markdown-editor": { file: "markdown-editor.md", content: inputMarkdownEditor },
  "input/autocomplete": { file: "input/autocomplete.md", content: inputAutocomplete },
  "input/number": { file: "input/number.md", content: inputNumber },
  "input/date-picker": { file: "input/date-picker.md", content: inputDatePicker },
  "input/select": { file: "input/select.md", content: inputSelect },
  "input/combobox": { file: "input/combobox.md", content: inputCombobox },
  "input/color": { file: "input/color.md", content: inputColor },
  "input/tags": { file: "input/tags.md", content: inputTags },
  "input/tag-editor": { file: "input/tag-editor.md", content: inputTagEditor },
  "input/pin": { file: "input/pin.md", content: inputPin },
  "input/image": { file: "input/image.md", content: inputImage },
  "input/image-cropper": { file: "input/image-cropper.md", content: inputImageCropper },
  "input/file-dropzone": { file: "input/file-dropzone.md", content: inputFileDropzone },
  "input/icon": { file: "input/icon.md", content: inputIcon },
  "input/slider": { file: "input/slider.md", content: inputSlider },
  "input/boolean": { file: "input/boolean.md", content: inputBoolean },
  "actions/buttons": { file: "actions/buttons.md", content: actionButtons },
  "actions/copy-remove": { file: "actions/copy-remove.md", content: actionCopyRemove },
  "actions/menus": { file: "actions/menus.md", content: actionMenus },
  "actions/filters": { file: "filter-chip.md", content: actionFilters },
  "actions/segmented-control": { file: "actions/segmented-control.md", content: actionSegmentedControl },
  "actions/tabs": { file: "actions/tabs.md", content: actionTabs },
  "actions/disclosure": { file: "actions/disclosure.md", content: actionDisclosure },
  "actions/toolbar": { file: "actions/toolbar.md", content: actionToolbar },
  "actions/spotlight": { file: "actions/spotlight.md", content: actionSpotlight },
  "layout/workspace": { file: "layout/workspace.md", content: layoutWorkspace },
  "layout/detail-panel": { file: "layout/detail-panel.md", content: layoutDetailPanel },
  "layout/discussion": { file: "layout/discussion.md", content: layoutDiscussion },
  "layout/panes": { file: "layout/panes.md", content: layoutPanes },
  "layout/scroll-area": { file: "layout/scroll-area.md", content: layoutScrollArea },
  "layout/overview": { file: "layout/overview.md", content: layoutOverview },
  "layout/settings-modal": { file: "layout/settings-modal.md", content: layoutSettingsModal },
  "layout/panel-dialog": { file: "layout/panel-dialog.md", content: layoutPanelDialog },
  "layout/floating-window": { file: "layout/floating-window.md", content: layoutFloatingWindow },
  "surfaces/utilities": { file: "surfaces/utilities.md", content: surfaceUtilities },
  "surfaces/paper": { file: "surfaces/paper.md", content: surfacePaper },
  "surfaces/empty-states": { file: "surfaces/empty-states.md", content: surfaceEmptyStates },
  "surfaces/details": { file: "surfaces/details.md", content: surfaceDetails },
  "surfaces/cards": { file: "surfaces/cards.md", content: surfaceCards },
  "surfaces/progress": { file: "surfaces/progress.md", content: surfaceProgress },
  "surfaces/stats": { file: "surfaces/stats.md", content: surfaceStats },
  "surfaces/observability": { file: "surfaces/observability.md", content: surfaceObservability },
  "feedback/blocks": { file: "feedback/blocks.md", content: feedbackBlocks },
  "feedback/badges": { file: "feedback/badges.md", content: feedbackBadges },
  "feedback/toast": { file: "feedback/toast.md", content: feedbackToast },
  "feedback/tooltip": { file: "feedback/tooltip.md", content: feedbackTooltip },
  "feedback/prompts": { file: "feedback/prompts.md", content: feedbackPrompts },
  "content/charts": { file: "content/charts.md", content: contentCharts },
  "content/tables": { file: "content/tables.md", content: contentTables },
  "content/calendar": { file: "surfaces/calendar.md", content: contentCalendar },
  "content/pagination": { file: "layout/pagination.md", content: contentPagination },
  "content/code": { file: "content/code.md", content: contentCode },
  "content/logs": { file: "content/logs.md", content: contentLogs },
  "content/structured-data": { file: "content/structured-data.md", content: contentStructuredData },
  "content/media": { file: "content/media.md", content: contentMedia },
  "content/files": { file: "content/files.md", content: contentFiles },
  "content/template-editor": { file: "content/template-editor.md", content: contentTemplateEditor },
  "content/docs": { file: "content/docs.md", content: contentDocs },
  "content/markdown": { file: "content/markdown.md", content: contentMarkdown },
  "widgets/composition": { file: "widgets/dashboard.md", content: widgetDashboard },
  "cloud/assistant-chat": { file: "cloud/assistant-chat.md", content: cloudAssistantChat },
  "cloud/permissions": { file: "layout/permissions.md", content: layoutPermissions },
  "cloud/dashboard-widgets": { file: "cloud/dashboard-widgets.md", content: cloudDashboardWidgets },
  "cloud/resource-picker": { file: "cloud/resource-picker.md", content: cloudResourcePicker },
} as const satisfies Record<string, { file: string; content: string }>;

type CatalogContextId = keyof typeof catalogContextSources;

export const catalogContexts = Object.fromEntries(Object.entries(catalogContextSources).map(([id, source]) => [id, source.content])) as {
  readonly [Id in CatalogContextId]: (typeof catalogContextSources)[Id]["content"];
};

export const catalogContextFiles = Object.fromEntries(Object.entries(catalogContextSources).map(([id, source]) => [id, source.file])) as {
  readonly [Id in CatalogContextId]: (typeof catalogContextSources)[Id]["file"];
};

export const standaloneUiContextFiles = {
  "getting-started.md": "Portable package installation, style scoping, theming, and SSR setup guide.",
  "overview.md": "Catalog landing-page context rendered by the collection root.",
} as const satisfies Record<string, string>;
