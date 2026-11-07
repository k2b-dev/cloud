import { type ComponentProps, mergeProps, untrack } from "solid-js";
import { DeferredChatContent } from "./deferred-chat-content";

// Rare destinations render the same loading surface on the server and on every
// first client render, including remounts after enhanced navigation. Their already
// authorized SSR seeds stay in props and are consumed once when the code arrives.
const loadChatInfoPanel = () => import("./ChatInfoPanel").then((module) => module.default);
export const ChatInfoPanel = (props: ComponentProps<typeof import("./ChatInfoPanel").default>) => (
  <DeferredChatContent load={loadChatInfoPanel} contentProps={props} />
);
const loadChatThreadsPage = () => import("./ChatThreadsPage").then((module) => module.default);
export const ChatThreadsPage = (props: ComponentProps<typeof import("./ChatThreadsPage").default>) => (
  <DeferredChatContent load={loadChatThreadsPage} contentProps={props} />
);
const loadDiscoverChannels = () => import("./DiscoverChannels").then((module) => module.default);
export const DiscoverChannels = (props: ComponentProps<typeof import("./DiscoverChannels").default>) => {
  // The SSR seed is consumed once, even while the component code is still loading.
  const initial = untrack(() => ({ page: props.initial, revision: props.revision, query: props.query }));
  return (
    <DeferredChatContent
      load={loadDiscoverChannels}
      contentProps={mergeProps(props, {
        get initial() {
          return props.revision === initial.revision && props.query === initial.query ? initial.page : undefined;
        },
      })}
    />
  );
};
const loadForYou = () => import("./ForYou").then((module) => module.default);
export const ForYou = (props: ComponentProps<typeof import("./ForYou").default>) => {
  // The SSR seed is consumed once, even while the component code is still loading.
  const initial = untrack(() => ({ page: props.initial, revision: props.revision }));
  return (
    <DeferredChatContent
      load={loadForYou}
      contentProps={mergeProps(props, {
        get initial() {
          return props.revision === initial.revision ? initial.page : undefined;
        },
      })}
    />
  );
};
const loadChatThreadColumn = () => import("./ChatThreadColumn").then((module) => module.default);
export const ChatThreadColumn = (props: ComponentProps<typeof import("./ChatThreadColumn").default>) => (
  <DeferredChatContent load={loadChatThreadColumn} contentProps={props} />
);
const loadChatSearch = () => import("./ChatSearch").then((module) => module.default);
export const ChatSearch = (props: ComponentProps<typeof import("./ChatSearch").default>) => (
  <DeferredChatContent load={loadChatSearch} contentProps={props} />
);
