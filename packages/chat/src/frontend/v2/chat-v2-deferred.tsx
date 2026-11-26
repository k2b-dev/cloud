import { importOnDemand } from "@k2b/cloud/browser/reload";
import { Failed, Loading, useLocale } from "@k2b/ui/v2";
import {
  type Component,
  type ComponentProps,
  createSignal,
  type JSX,
  Match,
  mergeProps,
  onCleanup,
  onMount,
  Switch,
  untrack,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { chatMessages } from "../../messages";

/**
 * A rare page of Chat (For you, Discover channels) loads its code when it opens, as v1's do: the server and the first
 * client render show the page's one loading state in its place; a failed load says so with "Try again".
 */
function DeferredV2<P extends object>(props: { load: () => Promise<Component<P>>; contentProps: P }): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const [component, setComponent] = createSignal<Component<P>>();
  const [failed, setFailed] = createSignal(false);
  let active = true;
  const load = async () => {
    setFailed(false);
    const loaded = await importOnDemand(props.load);
    if (!active) return;
    if (loaded) setComponent(() => loaded);
    else setFailed(true);
  };
  onMount(() => void load());
  onCleanup(() => {
    active = false;
  });
  return (
    <Switch>
      <Match when={component()}>{(loaded) => <Dynamic component={loaded()} {...props.contentProps} />}</Match>
      <Match when={failed()}>
        <Failed text={t().requestFailed} onRetry={() => void load()} />
      </Match>
      <Match when={true}>
        <Loading rows={6} lines={2} />
      </Match>
    </Switch>
  );
}

type ForYouProps = ComponentProps<typeof import("./ChatPagesV2").ForYouV2>;
const loadForYou = () => import("./ChatPagesV2").then((module) => module.ForYouV2);
/** "For you" in its pane; the server's first page is handed over once, as in v1. */
export const ForYouPaneV2 = (props: ForYouProps) => {
  const initial = untrack(() => ({ page: props.initial, revision: props.revision }));
  return (
    <DeferredV2
      load={loadForYou}
      contentProps={mergeProps(props, {
        get initial() {
          return props.revision === initial.revision ? initial.page : undefined;
        },
      })}
    />
  );
};

type DiscoverProps = ComponentProps<typeof import("./ChatPagesV2").DiscoverChannelsV2>;
const loadDiscover = () => import("./ChatPagesV2").then((module) => module.DiscoverChannelsV2);
/** "Discover channels" in its pane; the server's first page is handed over once, as in v1. */
export const DiscoverChannelsPaneV2 = (props: DiscoverProps) => {
  const initial = untrack(() => ({ page: props.initial, revision: props.revision, query: props.query }));
  return (
    <DeferredV2
      load={loadDiscover}
      contentProps={mergeProps(props, {
        get initial() {
          return props.revision === initial.revision && props.query === initial.query ? initial.page : undefined;
        },
      })}
    />
  );
};

type ThreadsProps = ComponentProps<typeof import("./ChatPagesV2").ThreadsPageV2>;
const loadThreads = () => import("./ChatPagesV2").then((module) => module.ThreadsPageV2);
/** A chat's threads as the phone's page, loaded when it opens, as v1's is. */
export const ThreadsPaneV2 = (props: ThreadsProps) => <DeferredV2 load={loadThreads} contentProps={props} />;
