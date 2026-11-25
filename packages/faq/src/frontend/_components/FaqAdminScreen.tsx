import { navigateTo } from "@k2b/ssr/nav";
import {
  Band,
  Bar,
  Button,
  Check,
  Dialog,
  Empty,
  Field,
  Input,
  List,
  Menu,
  Notice,
  Pane,
  Row,
  StatusRow,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { CreateFaq, FaqAudience, FaqEntry, FaqTranslations } from "@/contracts";
import { type FaqText, useFaqMessages } from "../messages";
import type { FaqAdminEntry, FaqAdminOpen } from "./faq-admin-open";

type Props = { entries: readonly FaqAdminEntry[]; open: FaqAdminOpen | null };

export const FAQ_ADMIN_PATH = "/admin/faq";
export const faqEntryHref = (id: string) => `${FAQ_ADMIN_PATH}?entry=${encodeURIComponent(id)}`;
const NEW_HREF = `${FAQ_ADMIN_PATH}?entry=new`;

const AUDIENCES: readonly FaqAudience[] = ["anonymous", "guest", "user"];
const audienceLabel = (t: FaqText, audience: FaqAudience, long = false) =>
  audience === "anonymous" ? (long ? t.anonymousFull : t.anonymous) : audience === "guest" ? t.guests : t.users;

const failure = async (response: { json(): Promise<unknown> }, fallback: string) => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
};

/**
 * The FAQ administration on v2: the entries as a list, the open one (or a new one) as a form beside it. What is open
 * lives in the address (`?entry=<id>` or `?entry=new`), so reload, back and a link show the same form.
 */
export default function FaqAdminScreen(props: Props) {
  const t = useFaqMessages();
  const currentId = () => (props.open?.kind === "edit" ? props.open.entry.id : null);
  return (
    <Workspace
      detail
      detailEmpty={{ icon: "help", text: t().noneOpen }}
      // k2b-ui gap: AdminLayout has no v2 form yet, so the admin sidebar is missing on this page; the shell's trail
      // (Start › Admin › FAQ) leads back to the admin area until AdminLayout ui="v2" lands.
      head={
        <Bar
          start={<Text type="body">FAQ</Text>}
          end={
            <>
              <Button variant="ghost" icon="external-link" href="/faq">
                {t().viewFaq}
              </Button>
              <Button variant="primary" icon="plus" href={NEW_HREF}>
                {t().newEntry}
              </Button>
            </>
          }
        />
      }
      primary={{ label: t().newEntry, icon: "plus", href: NEW_HREF }}
    >
      <Pane.Split>
        <Pane
          label={t().entries}
          width={{ min: 320, default: 400 }}
          scrollKey="faq-admin"
          status={<StatusRow lead={t().entryCount({ count: props.entries.length })} facts={[{ before: t().visibleAt, value: "/faq" }]} />}
        >
          <Show
            when={props.entries.length > 0}
            fallback={<Empty icon="help" text={t().noAdminEntries} action={{ label: t().newEntry, icon: "plus", href: NEW_HREF }} />}
          >
            <List label={t().entries}>
              <For each={props.entries}>
                {(item) => (
                  <Row
                    icon="help-circle"
                    lines={[item.question, item.entry.audience.map((audience) => audienceLabel(t(), audience)).join(" · ") || "–"]}
                    meta={Object.keys(item.entry.translations)
                      .map((locale) => locale.toUpperCase())
                      .join(" ")}
                    current={item.entry.id === currentId()}
                    href={faqEntryHref(item.entry.id)}
                  />
                )}
              </For>
            </List>
          </Show>
        </Pane>
        <Show when={props.open} keyed>
          {(open) =>
            open.kind === "missing" ? (
              <Pane
                detail
                label={t().entries}
                back={{ label: "FAQ", href: FAQ_ADMIN_PATH }}
                head={
                  <Bar
                    start={<Text type="lead">FAQ</Text>}
                    end={<Button variant="ghost" icon="x" label={t().close} href={FAQ_ADMIN_PATH} />}
                  />
                }
              >
                <Notice tone="warn" icon="alert-triangle">
                  {t().notFound}
                </Notice>
              </Pane>
            ) : (
              <FaqEntryForm open={open} />
            )
          }
        </Show>
      </Pane.Split>
    </Workspace>
  );
}

type Errors = Partial<Record<"questionEn" | "answerEn" | "questionDe" | "answerDe" | "audience", string>>;

/** The form of one entry beside the list. It saves with a default button: the page's one primary is "New entry". */
function FaqEntryForm(props: { open: Exclude<FaqAdminOpen, { kind: "missing" }> }) {
  const t = useFaqMessages();
  const toast = useToast();
  const entry = props.open.kind === "edit" ? props.open.entry : undefined;
  const [questionEn, setQuestionEn] = createSignal(entry?.translations.en?.question ?? "");
  const [answerEn, setAnswerEn] = createSignal(entry?.translations.en?.answer ?? "");
  const [questionDe, setQuestionDe] = createSignal(entry?.translations.de?.question ?? "");
  const [answerDe, setAnswerDe] = createSignal(entry?.translations.de?.answer ?? "");
  const [audience, setAudience] = createSignal<FaqAudience[]>(entry?.audience ?? ["guest", "user"]);
  const [errors, setErrors] = createSignal<Errors>({});
  const [failed, setFailed] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const title = () => (props.open.kind === "edit" ? props.open.question : t().createTitle);

  const clear = (key: keyof Errors) => setErrors((current) => ({ ...current, [key]: undefined }));
  const toggle = (value: FaqAudience, selected: boolean) => {
    setAudience((current) => (selected ? [...current.filter((item) => item !== value), value] : current.filter((item) => item !== value)));
    clear("audience");
  };

  const validate = (): CreateFaq | null => {
    const english = { question: questionEn().trim(), answer: answerEn().trim() };
    const german = { question: questionDe().trim(), answer: answerDe().trim() };
    const next: Errors = {
      questionEn: english.question ? undefined : t().questionRequired,
      answerEn: english.answer ? undefined : t().answerRequired,
      questionDe: german.answer && !german.question ? t().questionRequired : undefined,
      answerDe: german.question && !german.answer ? t().answerRequired : undefined,
      audience: audience().length > 0 ? undefined : t().chooseAudience,
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return null;
    // Translations this form does not edit (other locales from the CLI) stay as they are.
    const { de: _german, en: _english, ...others } = entry?.translations ?? {};
    const translations: FaqTranslations = { ...others, en: english, ...(german.question ? { de: german } : {}) };
    return { translations, audience: AUDIENCES.filter((value) => audience().includes(value)) };
  };

  const save = async () => {
    if (saving()) return;
    const data = validate();
    if (!data) return;
    setSaving(true);
    setFailed(null);
    try {
      if (entry) {
        const response = await apiClient[":id"].$patch({ param: { id: entry.id }, json: data });
        if (!response.ok) return setFailed(await failure(response, t().updateFailed));
        toast(t().updated, { status: "ok" });
        navigateTo(faqEntryHref(entry.id));
      } else {
        const response = await apiClient.index.$post({ json: data });
        if (!response.ok) return setFailed(await failure(response, t().createFailed));
        const created = (await response.json().catch(() => null)) as { id?: string } | null;
        toast(t().created, { status: "ok" });
        navigateTo(created?.id ? faqEntryHref(created.id) : FAQ_ADMIN_PATH);
      }
    } catch {
      setFailed(entry ? t().updateFailed : t().createFailed);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (target: FaqEntry, question: string) => {
    const agreed = await Dialog.confirm({ title: t().deleteTitle, description: t().deleteQuestion({ question }), confirm: t().delete });
    if (!agreed) return;
    setFailed(null);
    try {
      const response = await apiClient[":id"].$delete({ param: { id: target.id } });
      if (!response.ok) return setFailed(await failure(response, t().deleteFailed));
      toast(t().deleted, { status: "ok" });
      navigateTo(FAQ_ADMIN_PATH);
    } catch {
      setFailed(t().deleteFailed);
    }
  };

  return (
    <Pane
      detail
      label={title()}
      back={{ label: "FAQ", href: FAQ_ADMIN_PATH }}
      head={
        <Bar
          start={<Text type="lead">{title()}</Text>}
          end={
            <>
              <Show when={props.open.kind === "edit" && props.open}>
                {(open) => (
                  <Menu
                    label={t().moreActions}
                    items={[{ label: t().delete, icon: "trash", danger: true, onClick: () => void remove(open().entry, open().question) }]}
                  />
                )}
              </Show>
              <Button variant="ghost" icon="x" label={t().close} href={FAQ_ADMIN_PATH} />
            </>
          }
        />
      }
    >
      <Show when={failed()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
      <Band>
        <Field name="question-en" label={t().questionIn({ language: t().english })} required error={errors().questionEn}>
          <Input
            value={questionEn()}
            placeholder={t().questionPlaceholderEn}
            onInput={(value) => {
              setQuestionEn(value);
              clear("questionEn");
            }}
          />
        </Field>
        {/* k2b-ui gap: a multiline Input is 80 px high and does not grow; v1 showed eight lines for an answer. */}
        <Field name="answer-en" label={t().answerIn({ language: t().english })} hint={t().markdownHint} required error={errors().answerEn}>
          <Input
            multiline
            value={answerEn()}
            onInput={(value) => {
              setAnswerEn(value);
              clear("answerEn");
            }}
          />
        </Field>
      </Band>
      <Band>
        <Field
          name="question-de"
          label={t().questionIn({ language: t().german })}
          optional={t().optional}
          hint={t().germanHint}
          error={errors().questionDe}
        >
          <Input
            value={questionDe()}
            placeholder={t().questionPlaceholderDe}
            onInput={(value) => {
              setQuestionDe(value);
              clear("questionDe");
            }}
          />
        </Field>
        <Field
          name="answer-de"
          label={t().answerIn({ language: t().german })}
          optional={t().optional}
          hint={t().markdownHint}
          error={errors().answerDe}
        >
          <Input
            multiline
            value={answerDe()}
            onInput={(value) => {
              setAnswerDe(value);
              clear("answerDe");
            }}
          />
        </Field>
      </Band>
      <Band>
        {/* k2b-ui gap: Check has no description line; the old per-audience descriptions are one hint on the field. */}
        <Field name="audience" label={t().audience} hint={t().audienceHint} error={errors().audience}>
          <For each={AUDIENCES}>
            {(value) => (
              <Check
                label={audienceLabel(t(), value, true)}
                checked={audience().includes(value)}
                onChange={(selected) => toggle(value, selected)}
              />
            )}
          </For>
        </Field>
      </Band>
      <Bar
        end={
          <>
            <Button href={FAQ_ADMIN_PATH}>{t().cancel}</Button>
            <Button icon="check" busy={saving()} onClick={() => void save()}>
              {entry ? t().save : t().create}
            </Button>
          </>
        }
      />
    </Pane>
  );
}
