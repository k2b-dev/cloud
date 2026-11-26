import type { AiOpenQuestion } from "@k2b/cloud/ai";
import Approvals from "@k2b/cloud/approvals/list";
import { useLocale } from "@k2b/ui";
import { Band, Button, Canvas, Empty, Failed, List, Loading, Pane, Row, Section, StatusRow, useToast } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import type { WaitingAutomation } from "../../waiting-automations";
import { type AssistantApprovalsViewProps, createWaitingPage } from "../AssistantApprovalsView";
import { automationMessages } from "../AssistantWaitingAutomations";
import { WAITING_KIND_ICON } from "../AssistantWaitingStrip";
import { assistantMessages } from "../messages";
import { iconName } from "./assistant-nav";

/**
 * Waiting for you on v2: one statement of how much waits, then the approvals, the secrets and the versions Gustav asks
 * about, and the person's automations that need them, each a section of rows with the one way to act. The same state
 * as the v1 view (`createWaitingPage`), so the row above the field, its count and this page agree.
 */
export default function AssistantWaitingV2(props: AssistantApprovalsViewProps & { total: () => number }) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const a = () => automationMessages.resolve([locale()]).t;
  const toast = useToast();
  const page = createWaitingPage(props);
  // The one count of what waits, the same as the sidebar's badge and the row above the field.
  const total = () => props.total();
  const [restoring, setRestoring] = createSignal<string | null>(null);
  const restore = async (chat: { id: string; title: string }) => {
    if (restoring()) return;
    setRestoring(chat.id);
    const response = await fetch(`/api/ai/conversations/${encodeURIComponent(chat.id)}/restore`, {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => null);
    if (!response?.ok) {
      setRestoring(null);
      toast(a().restoreFailedTitle, { status: "bad", retry: () => restore(chat) });
      return;
    }
    toast(a().restored({ title: chat.title }), { status: "ok" });
    await page.refreshAutomations();
    setRestoring(null);
  };
  const questionRows = (questions: readonly AiOpenQuestion[]) => (
    <List label={t().waitingForYou}>
      <For each={questions}>
        {(question) => (
          <Row
            icon={iconName(WAITING_KIND_ICON[question.kind], "alert-circle")}
            lines={
              question.conversationTitle ? [question.short, t().waitingInChat({ title: question.conversationTitle })] : [question.short]
            }
            onOpen={() => props.onJump(question)}
            action={{ label: t().waitingView, onClick: () => props.onJump(question) }}
          />
        )}
      </For>
    </List>
  );
  const automationAction = (entry: WaitingAutomation) =>
    entry.archivedChat
      ? {
          label: a().restoreChat,
          disabled: restoring() !== null,
          onClick: () => void restore(entry.archivedChat!),
        }
      : entry.href
        ? { label: entry.reason === "chat_missing" ? a().chooseChat : a().view, href: entry.href }
        : undefined;
  return (
    <Pane
      label={t().waitingForYou}
      // The statement only stands when it is true: not while the page loads, not beside a failed read.
      status={
        <Show when={!page.loading() && page.approvals()}>
          <StatusRow lead={t().waitingStatus({ count: total() })} facts={[{ value: t().waitingLead }]} />
        </Show>
      }
    >
      <Show when={!page.loading()} fallback={<Loading rows={3} lines={2} />}>
        <Show when={page.approvals()} fallback={<Failed text={`${t().waitingFailed} ${t().waitingFailedHint}`} onRetry={page.retry} />}>
          {(approvals) => (
            <Show when={!page.empty()} fallback={<Empty icon="mood-check" text={t().waitingEmptyHint} />}>
              <Show when={approvals().count > 0}>
                <Section icon="shield-check" title={t().waitingApprovals} count={approvals().count}>
                  {/* k2b-ui gap: the shared approval list on v2 comes with #4200 (@k2b/cloud/approvals/v2); until then
                      v1's list draws itself here. Keyed by the page read, as in v1. */}
                  <Canvas label={t().waitingApprovals}>
                    {/* Inside the drawing the list keeps the pane's text edge of 20 px. */}
                    <div style={{ padding: "0 20px" }}>
                      <Show when={approvals()} keyed>
                        {(current) => <Approvals app="assistant" initial={current} />}
                      </Show>
                    </div>
                  </Canvas>
                </Section>
              </Show>
              <Show when={page.secrets().length > 0}>
                <Section icon="key" title={t().waitingSecrets} count={page.secrets().length}>
                  {questionRows(page.secrets())}
                </Section>
              </Show>
              <Show when={page.versions().length > 0}>
                <Section icon="power" title={t().waitingVersions} count={page.versions().length}>
                  {questionRows(page.versions())}
                </Section>
              </Show>
              <Show when={page.automationsShow()}>
                <Section icon="stack-2" title={a().heading} count={page.shownAutomations()?.length}>
                  <Show when={page.shownAutomations()} fallback={<Failed text={a().failed} onRetry={page.loadAutomations} />}>
                    {(entries) => (
                      <List label={a().heading}>
                        <For each={entries()}>
                          {(entry) => (
                            <Row
                              icon="alert-circle"
                              lines={
                                entry.reason
                                  ? [entry.short, entry.archivedChat ? a().chat_missing_archived : a()[entry.reason]]
                                  : [entry.short]
                              }
                              href={entry.archivedChat ? entry.href : undefined}
                              action={automationAction(entry)}
                            />
                          )}
                        </For>
                      </List>
                    )}
                  </Show>
                </Section>
              </Show>
            </Show>
          )}
        </Show>
      </Show>
      <Show when={page.paging().cursor || page.paging().failed}>
        <Band>
          <Button
            variant="text"
            icon={page.paging().failed ? "refresh" : "chevron-down"}
            busy={page.paging().loading}
            onClick={() => void page.loadMore()}
          >
            {page.paging().failed ? t().codeViewRetry : t().waitingLoadMore}
          </Button>
        </Band>
      </Show>
    </Pane>
  );
}
