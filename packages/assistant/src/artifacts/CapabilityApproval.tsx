import { AiChatActionsProvider, AiTurnBlockView } from "@k2b/cloud/ai/ui";
import { NoticeCard, prompts, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { artifactMessages } from "./messages";
import type { ApproveCapability, CapabilityApproval, CapabilityDecision } from "./runtime/capabilities";

function Approval(props: { request: CapabilityApproval; respond: (value: CapabilityDecision) => void }) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t;
  return (
    <>
      <Show when={props.request.resource}>
        {(resource) => <NoticeCard tone="warning" title={resource().title} detail={t().sharedCodeHelp} />}
      </Show>
      <AiChatActionsProvider
        actions={{
          // This card names no chat, so it offers no chat reach: its decision is once or always.
          onApproval: (_request, input) =>
            props.respond({ approved: input.approved, ...(input.remember === "always" ? { remember: "always" } : {}) }),
        }}
      >
        <AiTurnBlockView
          active
          turnId={props.request.id}
          block={{
            id: props.request.id,
            kind: "tool",
            callId: props.request.id,
            name: props.request.name,
            args: props.request.input,
            status: "awaiting_approval",
            presentation: {
              kind: "capability",
              appId: props.request.appId,
              appName: props.request.appName,
              appIcon: props.request.appIcon,
              title: props.request.title,
              capabilityKind: props.request.kind,
              ...(props.request.sentences ? { sentences: props.request.sentences } : {}),
              ...(props.request.fields ? { fields: [...props.request.fields] } : {}),
            },
            approval: {
              message: props.request.review?.message ?? `${props.request.appName}: ${props.request.title}`,
              review: props.request.review ?? undefined,
              allowAlways: props.request.allowAlways,
            },
          }}
        />
      </AiChatActionsProvider>
    </>
  );
}

export const approveInModal: ApproveCapability = async (request, signal) => {
  let decision: CapabilityDecision = { approved: false };
  await prompts.dialog<void>(
    (close) => {
      const abort = () => close();
      signal.addEventListener("abort", abort, { once: true });
      onCleanup(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) close();
      // An app asks from inside Cloud's page: its decision buttons arm late, so a click meant for the app cannot approve.
      const [armed, setArmed] = createSignal(false);
      const timer = setTimeout(() => setArmed(true), 500);
      onCleanup(() => clearTimeout(timer));
      return (
        <div inert={armed() ? undefined : true}>
          <Approval
            request={request}
            respond={(value) => {
              decision = value;
              signal.removeEventListener("abort", abort);
              close();
            }}
          />
        </div>
      );
    },
    { title: request.resource ? `${request.resource.title} · ${request.title}` : request.title, size: "medium" },
  );
  return decision;
};

export function createCodeApprovals() {
  type Pending = { request: CapabilityApproval; conversationId?: string; respond: (value: CapabilityDecision) => void };
  const [pending, setPending] = createSignal<Pending[]>([]);
  const ask: ApproveCapability = (request, signal, conversationId) =>
    new Promise((resolve, reject) => {
      const remove = () => setPending((items) => items.filter((item) => item.request.id !== request.id));
      const abort = () => {
        remove();
        reject(new Error("Run stopped"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      setPending((items) => [
        ...items,
        {
          request,
          conversationId,
          respond: (value) => {
            signal.removeEventListener("abort", abort);
            remove();
            resolve(value);
          },
        },
      ]);
    });
  const View = (props: { conversationTitle: (id: string) => string | undefined }) => {
    const locale = useLocale(),
      t = () => artifactMessages.resolve([locale()]).t;
    return (
      <For each={pending()}>
        {(item) => (
          <section>
            <p>
              {t().approvalChat({
                title: item.conversationId ? (props.conversationTitle(item.conversationId) ?? t().otherChat) : t().otherChat,
              })}
            </p>
            <Approval request={item.request} respond={item.respond} />
          </section>
        )}
      </For>
    );
  };
  return { ask, View };
}
