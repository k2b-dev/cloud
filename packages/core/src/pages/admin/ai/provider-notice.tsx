import { Disclosure, Notice, Text, useLocale } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { aiAreaHref } from "./area";
import { aiAdminApi, readAiAdmin, reloadAiArea } from "./client";
import { aiAreaMessages } from "./messages";
import { type AiProviderState, aiProviderFailureText, formatAiTime } from "./presentation";

/**
 * The provider's failure where the administration works: what is wrong, since when, and the way out. "Try again" tests
 * the stored connection and reloads with the new state; the technical answer of the provider stays folded away.
 */
export function AiProviderNotice(props: {
  providerId: string;
  providerLabel: string;
  state: AiProviderState;
  statusMessage: string | null;
  statusCode?: string | null;
  status?: string;
  checkedAt: string | null;
  /** Inside the connection form itself: no link to it. */
  inConnection?: boolean;
}) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const retry = async () => {
    setBusy(true);
    setError("");
    try {
      await readAiAdmin(await aiAdminApi.providers[":id"].test.$post({ param: { id: props.providerId } }), t().loadFailed);
      reloadAiArea();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().loadFailed);
      setBusy(false);
    }
  };
  const time = () => formatAiTime(locale(), props.checkedAt);
  const technical = () => [props.statusCode, props.statusMessage].filter(Boolean).join(" · ");
  const broken = () => props.state === "unreachable" || props.state === "badkey";
  const key = () => props.state === "badkey";
  return (
    <Show when={broken()}>
      <Notice
        tone="bad"
        icon={key() ? "key" : "plug-x"}
        title={key() ? t().badKeyTitle({ p: props.providerLabel }) : t().unreachTitle({ p: props.providerLabel })}
        actions={
          props.inConnection
            ? undefined
            : ([
                {
                  label: key() ? t().editKey : t().editConn,
                  icon: key() ? "key" : "pencil",
                  href: aiAreaHref({ sec: "providers", p: props.providerId, pane: "conn" }, key() ? { focus: "key" } : {}),
                },
              ] as const)
        }
        primary={{ label: t().retry, icon: "refresh", disabled: busy(), onClick: () => void retry() }}
      >
        {[
          key() ? t().testFailKey : aiProviderFailureText(t(), props.status, props.statusCode),
          time() ? (key() ? t().badKeySince({ time: time() }) : t().unreachSince({ time: time() })) : "",
        ]
          .filter(Boolean)
          .join(" ")}
      </Notice>
      <Show when={technical()}>
        <Disclosure title={t().technicalDetails}>
          <Text muted>{technical()}</Text>
        </Disclosure>
      </Show>
      <Show when={error()}>
        <Notice tone="bad" title={t().loadFailed}>
          {error()}
        </Notice>
      </Show>
    </Show>
  );
}
