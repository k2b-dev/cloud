import {
  ACCOUNT_ACTION_NOTICE_SAMPLE,
  AccountActionNoticeSchema,
  renderAccountActionNotice,
  renderLiquidTemplate,
} from "@k2b/cloud/shared";
import {
  Button,
  createTemplateEditorPanesLayout,
  ImageInput,
  NumberInput,
  Panes,
  prompts,
  renderSafeMarkdown,
  Select,
  Switch,
  TagsInput,
  TemplateEditor,
  TemplatePreview,
  TemplateSampleData,
  type TemplateVariable,
  type TemplateVariableKind,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { settingsMessages } from "./messages";
import type { SettingFieldDef } from "./setting-field";

export const settingControlId = (key: string) => `setting-${key.replaceAll(".", "-")}`;

export type FieldInputProps = {
  entry: SettingFieldDef;
  value: () => unknown;
  error: () => string | undefined;
  onChange: (value: unknown) => void;
};

type FieldRenderer = (props: FieldInputProps) => JSX.Element;

const FIELD_RENDERERS: Partial<Record<SettingFieldDef["kind"], FieldRenderer>> = {
  image: (props) => <ImageSettingInput value={props.value} error={props.error} onChange={props.onChange} />,
  boolean: (props) => <BooleanSettingInput value={props.value} error={props.error} onChange={props.onChange} />,
  number: (props) => <NumberSettingInput {...props} />,
  enum: (props) => <EnumSettingInput {...props} />,
  string_list: (props) => <StringListSettingInput {...props} />,
  number_list: (props) => <NumberListSettingInput {...props} />,
  text: (props) => <TextAreaSettingInput {...props} />,
  template: (props) => <TemplateSettingInput {...props} />,
};

export function FieldInput(props: FieldInputProps) {
  const render = FIELD_RENDERERS[props.entry.kind] ?? DefaultTextSettingInput;
  return render(props);
}

export function FieldError(props: { error: () => string | undefined }) {
  return (
    <Show when={props.error()}>
      <p class="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
        <i class="ti ti-alert-circle text-xs" /> {props.error()}
      </p>
    </Show>
  );
}

function ImageSettingInput(props: { value: () => unknown; error: () => string | undefined; onChange: (value: unknown) => void }) {
  return (
    <div class="flex flex-col gap-1">
      <ImageInput
        variant="small"
        value={() => (typeof props.value() === "string" && props.value() ? (props.value() as string) : null)}
        onValueChange={(v) => props.onChange(v ?? "")}
      />
      <FieldError error={props.error} />
    </div>
  );
}

function BooleanSettingInput(props: { value: () => unknown; error: () => string | undefined; onChange: (value: unknown) => void }) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  return (
    <div class="flex flex-col gap-1">
      <Switch
        label={props.value() ? t().enabled : t().disabled}
        value={() => Boolean(props.value())}
        onValueChange={(v) => props.onChange(v)}
      />
      <FieldError error={props.error} />
    </div>
  );
}

function NumberSettingInput(props: FieldInputProps) {
  return (
    <NumberInput
      aria-label={props.entry.label}
      aria-describedby={`${settingControlId(props.entry.key)}-description`}
      value={() => (typeof props.value() === "number" ? (props.value() as number) : 0)}
      onValueChange={(v) => props.onChange(v)}
      min={props.entry.min}
      max={props.entry.max}
      error={props.error}
    />
  );
}

function EnumSettingInput(props: FieldInputProps) {
  const options = (props.entry.options ?? []).map((o) => ({ id: o.value, value: o.value, label: o.label }));
  return (
    <Select
      aria-label={props.entry.label}
      aria-describedby={`${settingControlId(props.entry.key)}-description`}
      value={() => (typeof props.value() === "string" ? (props.value() as string) : (props.entry.options?.[0]?.value ?? ""))}
      onValueChange={(v) => props.onChange(v)}
      options={options}
      icon="ti ti-selector"
      error={props.error}
    />
  );
}

function StringListSettingInput(props: FieldInputProps) {
  return (
    <TagsInput
      value={() => (Array.isArray(props.value()) ? (props.value() as string[]) : [])}
      onValueChange={(v) => props.onChange(v)}
      placeholder={props.entry.placeholder ?? props.entry.label}
      error={props.error}
    />
  );
}

function NumberListSettingInput(props: FieldInputProps) {
  return (
    <TagsInput
      value={() => (Array.isArray(props.value()) ? (props.value() as number[]).map(String) : [])}
      onValueChange={(v) => props.onChange(v.map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0))}
      placeholder={props.entry.placeholder ?? props.entry.label}
      error={props.error}
    />
  );
}

function TextAreaSettingInput(props: FieldInputProps) {
  return (
    <TextInput
      multiline
      value={() => (typeof props.value() === "string" ? (props.value() as string) : "")}
      onValueChange={(v) => props.onChange(v)}
      placeholder={props.entry.placeholder ?? props.entry.label}
      error={props.error}
    />
  );
}

const TEMPLATE_SAMPLE_VALUES: Record<string, string> = {
  ACCOUNT_KIND: "full account",
  APP_NAME: "Cloud",
  CONTACT_EMAIL: "support@example.org",
  DISPLAY_NAME: "Eva Becker",
  EMAIL: "eva@example.org",
  EXPIRY: "Dec 31, 2026",
  EXTEND_URL: "https://cloud.example.org/me",
  FIRST_NAME: "Eva",
  LOGIN_URL: "https://cloud.example.org/auth/login",
  MAGIC_LINK: "https://cloud.example.org/auth/magic-link/example",
  PASSWORD: "correct horse battery staple",
  REASON: "The request could not be approved.",
  RESET_LINK: "https://cloud.example.org/auth/password-reset/example",
  TOKEN: "123456",
  USERNAME: "ebecker",
};

const sampleValueFor = (name: string) => TEMPLATE_SAMPLE_VALUES[name] ?? name.toLowerCase().replaceAll("_", " ");

const escapePreviewText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const buildEmailPreviewHtml = (content: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;" cellpadding="0" cellspacing="0">
        <tr><td style="background:#ffffff;padding:20px 24px;border-radius:12px 12px 0 0;border:1px solid #e4e4e7;border-bottom:none;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;">
              <span style="font-size:16px;font-weight:600;color:#18181b;">Cloud</span>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="background:#ffffff;padding:28px 24px;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7;">
          <div style="font-size:14px;line-height:1.6;color:#27272a;">
            ${content}
          </div>
        </td></tr>
        <tr><td style="background:#fafafa;padding:16px 24px;border-radius:0 0 12px 12px;border:1px solid #e4e4e7;border-top:none;">
          <p style="margin:0 0 8px;font-size:11px;color:#71717a;text-align:center;">
            <a href="https://cloud.example.org/impressum" style="color:#71717a;text-decoration:underline;">Imprint</a>
            &nbsp;&middot;&nbsp;
            <a href="https://cloud.example.org/legal/terms" style="color:#71717a;text-decoration:underline;">Terms</a>
            &nbsp;&middot;&nbsp;
            <a href="https://cloud.example.org/legal/privacy" style="color:#71717a;text-decoration:underline;">Privacy</a>
          </p>
          <p style="margin:0;font-size:11px;color:#a1a1aa;text-align:center;">
            This message was sent automatically. Please do not reply to this email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
`;

const createTemplateSampleData = (variables: readonly string[]): Record<string, string> =>
  Object.fromEntries(variables.map((name) => [name, sampleValueFor(name)]));

const renderTemplatePreviewBody = (template: string, variables: readonly string[], sampleData = createTemplateSampleData(variables)) => {
  try {
    return renderLiquidTemplate(template, Object.fromEntries(variables.map((name) => [name, sampleData[name] ?? sampleValueFor(name)])));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Template preview failed";
    return `<p style="color:#b91c1c;">${escapePreviewText(message)}</p>`;
  }
};

const renderTemplatePreview = (template: string, variables: readonly string[], sampleData?: Record<string, string>) =>
  buildEmailPreviewHtml(renderTemplatePreviewBody(template, variables, sampleData));

const inferTemplateVariableKind = (name: string): TemplateVariableKind => {
  if (name.endsWith("_URL") || name.endsWith("_LINK") || name === "LOGIN_URL" || name === "MAGIC_LINK" || name === "RESET_LINK") {
    return "url";
  }
  if (name.endsWith("_EMAIL") || name === "EMAIL") return "email";
  if (name.endsWith("_COUNT") || name.endsWith("_DAYS")) return "number";
  return "string";
};

function TemplateSettingInput(props: FieldInputProps) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const currentValue = () => (typeof props.value() === "string" ? (props.value() as string) : "");
  const variables = () => props.entry.templateVars ?? [];
  const isActionNotice = () => props.entry.key === "user.action_notice";
  const initialSampleData = (): Record<string, string> =>
    isActionNotice() ? { ...ACCOUNT_ACTION_NOTICE_SAMPLE } : createTemplateSampleData(variables());
  const previewHtml = (template: string, data = initialSampleData()) => {
    if (!isActionNotice()) return renderTemplatePreview(template, variables(), data);
    try {
      const markdown = renderAccountActionNotice(template, AccountActionNoticeSchema.parse(data));
      return buildEmailPreviewHtml(markdown ? renderSafeMarkdown(markdown) : `<p>${escapePreviewText(t().actionNoticeEmptyPreview)}</p>`);
    } catch (error) {
      return buildEmailPreviewHtml(`<p>${escapePreviewText(error instanceof Error ? error.message : t().templateHelp)}</p>`);
    }
  };
  const templateVariables = (): TemplateVariable[] => variables().map((name) => ({ name, kind: inferTemplateVariableKind(name) }));
  const preview = () => previewHtml(currentValue());

  const openEditor = async () => {
    const initialValue = currentValue();
    const result = await prompts.dialog<string>(
      (close) => {
        const [draft, setDraft] = createSignal(initialValue);
        const [layout, setLayout] = createSignal(createTemplateEditorPanesLayout());
        const [sampleData, setSampleData] = createSignal<Record<string, string>>(initialSampleData());
        const renderedPreview = createMemo(() => previewHtml(draft(), sampleData()));
        const setSampleValue = (name: string, value: string) => {
          setSampleData((current) => ({ ...current, [name]: value }));
        };

        return (
          <div class="flex min-h-0 flex-col gap-4">
            <div>
              <p class="text-xs text-dimmed">{props.entry.key}</p>
              <p class="mt-1 text-sm text-secondary">{props.entry.description}</p>
            </div>

            <p class="text-xs text-dimmed">{isActionNotice() ? t().actionNoticeDescription : t().templateHelp}</p>

            <div class="h-[min(62vh,46rem)] min-h-[34rem] min-w-0 overflow-hidden rounded-lg bg-zinc-100 p-2 dark:bg-zinc-900">
              <Panes
                layout={layout()}
                onLayoutChange={setLayout}
                class="h-full w-full"
                resizable={false}
                items={[
                  {
                    id: "html",
                    title: isActionNotice() ? "Markdown" : "HTML",
                    icon: "ti ti-code",
                    render: () => (
                      <div class="h-full min-h-0 overflow-auto">
                        <TemplateEditor
                          value={draft}
                          onValueChange={setDraft}
                          variables={templateVariables()}
                          placeholder={props.entry.placeholder ?? props.entry.label}
                          fill
                        />
                      </div>
                    ),
                  },
                  {
                    id: "preview",
                    title: t().preview,
                    icon: "ti ti-eye",
                    render: () => <TemplatePreview html={renderedPreview()} />,
                  },
                  {
                    id: "sample-data",
                    title: t().sampleData,
                    icon: "ti ti-database",
                    render: () => (
                      <TemplateSampleData variables={templateVariables()} values={sampleData()} onValueChange={setSampleValue} />
                    ),
                  },
                ]}
              />
            </div>

            <div class="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => close(undefined)}>
                {t().cancel}
              </Button>
              <Button type="button" size="sm" onClick={() => close(draft())}>
                <i class="ti ti-check" /> {t().save}
              </Button>
            </div>
          </div>
        );
      },
      { title: props.entry.label, icon: "ti ti-template", size: "wide" },
    );

    if (typeof result === "string" && result !== initialValue) props.onChange(result);
  };

  return (
    <div class="flex flex-col gap-2">
      <div class="grid gap-2 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/50 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div class="min-w-0">
          <p class="text-xs font-medium text-primary">{isActionNotice() ? t().actionNotice : t().htmlBodyTemplate}</p>
          <p class="mt-1 truncate text-xs text-dimmed">{props.entry.description}</p>
        </div>
        <Button type="button" variant="secondary" size="sm" class="justify-center" onClick={() => void openEditor()}>
          <i class="ti ti-pencil" /> {t().editTemplate}
        </Button>
      </div>

      <details class="group rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-secondary">
          <i class="ti ti-eye text-dimmed" />
          {t().preview}
          <i class="ti ti-chevron-down ml-auto text-dimmed transition-transform group-open:rotate-180" />
        </summary>
        <iframe class="h-56 w-full bg-white" sandbox="" srcdoc={preview()} title={t().templatePreview({ label: props.entry.label })} />
      </details>

      <FieldError error={props.error} />
    </div>
  );
}

function DefaultTextSettingInput(props: FieldInputProps) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  // Secrets are server-side redacted (see settings/app.ts redactSecretValue).
  // The input always starts empty; admin types a new value to change, leaves
  // empty to keep the current stored secret.
  const isSecret = props.entry.kind === "secret";
  return (
    <TextInput
      aria-label={props.entry.label}
      aria-describedby={`${settingControlId(props.entry.key)}-description`}
      value={() => (typeof props.value() === "string" ? (props.value() as string) : String(props.value() ?? ""))}
      onValueChange={(v) => props.onChange(v)}
      placeholder={isSecret ? t().leaveSecretEmpty : (props.entry.placeholder ?? props.entry.label)}
      type={props.entry.kind === "email" ? "email" : props.entry.kind === "url" ? "url" : "text"}
      password={isSecret}
      error={props.error}
    />
  );
}
