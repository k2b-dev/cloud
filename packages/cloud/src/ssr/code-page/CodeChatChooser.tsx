import { refreshCurrentPath } from "@k2b/ssr/nav";
import { Button, ChoiceList, createDelayedLoading, InlineGuidance, NoticeCard, prompts, Skeleton, TextInput, toast } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import { invokeCapabilityWithDataSchema } from "../../capabilities/client";
import { CloudResourceViewSchema } from "../../contracts/capabilities";
import { type CodeChatBinding, CodeChatBindingSchema } from "./data";
import type { PageText } from "./page-kit";

const ChatsSchema = z.array(CloudResourceViewSchema).max(100);
/** One page of the owner's active chats; the search narrows it, so no list grows without bound. */
const CHAT_LIMIT = 20;
const SEARCH_DELAY_MS = 250;

type Chat = { id: string; title: string };
/** The list as Core answered it, with the search text it answered. */
type Listed = { query: string; chats: Chat[] };

/**
 * The owner picks the chat their personal Code writes to. Only their own active chats are listed; the hint says the
 * chosen chat's project, model and files shape Gustav's answer. No new version, no approval: Core records the change
 * with its revision, and messages already waiting keep their chat.
 */
export async function openCodeChatChooser(params: { codeId: string; binding: CodeChatBinding; text: PageText }) {
  const t = params.text.t();
  await prompts.dialog<void>((close) => <ChatChooser {...params} close={() => close()} />, {
    title: t.chatDialogTitle,
    icon: "ti ti-message-chatbot",
  });
}

function ChatChooser(props: { codeId: string; binding: CodeChatBinding; text: PageText; close: () => void }) {
  const t = props.text.t;
  // A conflict reads the binding again, so the dialog keeps working with Core's current revision.
  const [binding, setBinding] = createSignal(props.binding);
  const current = () => {
    const chat = binding().chat;
    return chat?.state === "available" ? chat.id : null;
  };
  const [query, setQuery] = createSignal("");
  const [listed, setListed] = createSignal<Listed | null | "failed">(null);
  const [chosen, setChosen] = createSignal<string | null>(current());
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<"conflict" | "failed" | null>(null);
  // Placeholders only when the first list takes a moment; a later search keeps the previous list until it answers.
  const loading = createDelayedLoading(() => listed() === null);
  // One key per intended change, so a repeat after an unclear answer is the same request, not a conflict.
  const keys = new Map<string, string>();
  let request = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    request++;
    if (timer) clearTimeout(timer);
  });
  const load = async (text: string) => {
    const id = ++request;
    const result = await invokeCapabilityWithDataSchema(
      { appId: "core", capabilityId: "ai.chats.search", kind: "query", input: { query: text, limit: CHAT_LIMIT } },
      ChatsSchema,
    ).catch(() => null);
    if (id !== request) return;
    setListed(result?.ok ? { query: text, chats: result.data.data.map((view) => ({ id: view.ref.id, title: view.title })) } : "failed");
  };
  onMount(() => void load(""));
  const search = (text: string) => {
    setQuery(text);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void load(text.trim()), SEARCH_DELAY_MS);
  };
  const options = () => {
    const list = listed();
    return list && list !== "failed"
      ? list.chats.map((chat) => ({
          value: chat.id,
          label: chat.title,
          ...(chat.id === current() ? { marker: t().chatDialogCurrent } : {}),
        }))
      : [];
  };
  // Only a chat the person can see is saved; a search that hides the choice takes it back out of reach.
  const chosenShown = () => options().some((option) => option.value === chosen());
  const reread = async () => {
    const result = await invokeCapabilityWithDataSchema(
      { appId: "core", capabilityId: "code.chat_binding.read", kind: "query", input: { codeId: props.codeId } },
      CodeChatBindingSchema,
    ).catch(() => null);
    if (result?.ok) setBinding(result.data.data);
  };
  const save = async () => {
    const chatId = chosen();
    if (!chatId || chatId === current() || !chosenShown() || saving()) return;
    setSaving(true);
    setError(null);
    const revision = binding().revision;
    const keyOf = `${chatId}@${revision}`;
    const idempotencyKey = keys.get(keyOf) ?? crypto.randomUUID();
    keys.set(keyOf, idempotencyKey);
    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "core",
        capabilityId: "code.chat_binding.set",
        kind: "action",
        target: { type: "core.code", id: props.codeId },
        input: { chatId, revision },
        idempotencyKey,
      },
      CodeChatBindingSchema,
    ).catch(() => null);
    if (!result?.ok) {
      if (result?.error.code === "CONFLICT") await reread();
      setSaving(false);
      setError(result?.error.code === "CONFLICT" ? "conflict" : "failed");
      return;
    }
    setSaving(false);
    const chat = result.data.data.chat;
    if (chat?.state === "available") toast.success(t().chatChanged({ title: chat.title }));
    props.close();
    refreshCurrentPath();
  };
  const empty = () => {
    const list = listed();
    return list && list !== "failed" && list.query ? t().chatDialogNoMatch({ query: list.query }) : t().chatDialogNone;
  };
  return (
    <div class="cloud-code__chat-chooser">
      <p class="cloud-code__chat-chooser-hint">{t().chatDialogHint}</p>
      <TextInput label={t().chatDialogSearch} type="search" value={query()} onValueChange={search} />
      <div class="cloud-code__chat-chooser-list" aria-busy={listed() === null ? "true" : undefined}>
        <Show
          when={listed() !== "failed"}
          fallback={
            <InlineGuidance tone="danger" role="alert">
              {t().chatDialogFailed}
              <Button size="sm" variant="ghost" onClick={() => void load(query().trim())}>
                {t().tryAgain}
              </Button>
            </InlineGuidance>
          }
        >
          <Show
            when={listed() !== null}
            fallback={
              <Show when={loading()}>
                <div class="cloud-code__chat-chooser-skel">
                  <Skeleton class="cloud-code__chat-chooser-skel-row" />
                  <Skeleton class="cloud-code__chat-chooser-skel-row" />
                </div>
              </Show>
            }
          >
            <Show when={options().length > 0} fallback={<p class="cloud-code__quiet-line">{empty()}</p>}>
              <ChoiceList
                aria-label={t().chatDialogTitle}
                options={options()}
                value={chosen()}
                onValueChange={(value) => {
                  setChosen(value);
                  setError(null);
                }}
              />
            </Show>
          </Show>
        </Show>
      </div>
      <Show when={error()}>
        {(kind) => (
          <NoticeCard
            tone="danger"
            icon="ti ti-alert-triangle"
            title={kind() === "conflict" ? t().chatDialogConflict : t().chatDialogSaveFailed}
            detail={kind() === "conflict" ? t().chatDialogConflictDetail : t().chatDialogSaveFailedDetail}
            role="alert"
          />
        )}
      </Show>
      <div class="cloud-code__dialog-actions">
        <Button variant="secondary" onClick={() => props.close()}>
          {t().chatDialogCancel}
        </Button>
        <Button
          variant="primary"
          loading={saving()}
          disabled={!chosen() || chosen() === current() || !chosenShown()}
          onClick={() => void save()}
        >
          {t().chatDialogSave}
        </Button>
      </div>
    </div>
  );
}
