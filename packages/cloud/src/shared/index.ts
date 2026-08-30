// Cloud-specific shared utils (NOT in stdlib)

// Re-export from stdlib for backward compatibility
// Prefer importing directly from @k2b/stdlib
export { dates, dates as calendar, encoding, fileIcons, gradients } from "@k2b/stdlib";
export * from "./account-display";
export * from "./account-session";
export type { AiPromptContextInput, AiToolPromptHint } from "./ai-platform-prompt";
export { AI_PLATFORM_PROMPT_TEMPLATE, aiPromptContext, renderAiPlatformPrompt } from "./ai-platform-prompt";
export * from "./app-presentation";
export * from "./app-url";
export * from "./branding";
export * from "./email-html";
export * from "./format";
export * from "./help";
export type * from "./icons";
export { icons } from "./icons";
export * from "./locale";
export * from "./login-method";
export { markdown } from "./markdown";
export type { ErrorCode, EvalContext, EvalError, EvalResult, EvalValue, ProgressValue } from "./markdown/formula";
export { createProgressValue, evaluateFormula, formatValue, isFormula, isTotalRow, parseProgressValue } from "./markdown/formula";
export type { MockCover, MockCoverIcon, MockCoverOptions, MockCoverTheme } from "./mock-cover";
export { createMockCover, createMockCoverSvg, parseDataUrl } from "./mock-cover";
export * from "./network-address";
export * from "./redirect";
export type { LiquidTemplateErrorReason, LiquidTemplateFilter, LiquidTemplateOptions } from "./template-rendering";
export {
  escapeTemplateOutput,
  LiquidTemplateError,
  liquidTemplateVariables,
  migrateLegacyMustacheTemplate,
  renderLiquidTemplate,
  validateLiquidTemplate,
} from "./template-rendering";
export * from "./theme";
export * from "./time";
