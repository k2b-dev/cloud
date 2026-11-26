import type { AiConversation } from "@k2b/cloud/ai";
import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { type Action, Bar, Canvas, Menu, Nav, Pane, Path, Workspace } from "@k2b/ui/v2";
import { type Accessor, createSignal, type JSX, lazy, Show, Suspense } from "solid-js";
import { assistantMessages } from "../messages";
import { type AssistantNavOptions, createAssistantNav } from "./assistant-nav";
import { assistantV2Messages } from "./assistant-v2-messages";

/**
 * The chat and its tabs scroll inside themselves, so they fill the Canvas without asking for their own height.
 * k2b-ui gap: on the phone a pane with a `Canvas height="fill"` takes `min-height: min-content`, so a drawing as
 * tall as its content (a chat with a long history) grows the pane past the screen and pushes the composer out of view.
 * Laid out from the Canvas's edges, the drawing reports no height of its own and the Canvas keeps the height left.
 */
const drawing = { position: "absolute", inset: "0", display: "flex", "flex-direction": "column", "min-height": "0" } as const;

/** The details of a chat load when someone opens them. */
const ChatDetails = lazy(() => import("./AssistantChatDetailsDialog"));

export type AssistantFrameV2Props = {
  nav: Omit<AssistantNavOptions, "showDetails" | "newChat">;
  /** The chat the page shows, whose deeds stand behind the head's "…"; null on a view or a Project. */
  openChat: Accessor<AiConversation | null>;
  /** Where the page stands after "Gustav": the open chat, Project or view. */
  path: Accessor<readonly { label: string; href?: string }[]>;
  newChat: Accessor<Action>;
  /** The chat, a Project or a view: the Assistant's own surface, drawn by the shared chat parts. */
  main: JSX.Element;
  /** The chat's tabs beside it while one is open; on the phone they are the page until the person goes back. */
  tabs: {
    open: Accessor<boolean>;
    back: Accessor<Action>;
    content: JSX.Element;
  };
};

/**
 * The Assistant on @k2b/ui v2: the sidebar as `Nav` (and the phone menu) led by "New chat" and the search of every
 * chat, as v1's sidebar was; the head with where the page stands and the open chat's deeds; the chat with its tabs
 * beside it. The composer is the page's main action, so no button floats over the chat on the phone. The chat itself,
 * its answers, cards and the composer are Cloud's shared chat parts; they keep their behaviour and draw themselves in
 * a `Canvas` that fills the pane.
 */
export default function AssistantFrameV2(props: AssistantFrameV2Props) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const v2 = () => assistantV2Messages.resolve([locale()]).t;
  const [detailsOf, setDetailsOf] = createSignal<string | null>(null);
  const nav = createAssistantNav({
    ...props.nav,
    newChat: () => props.newChat(),
    showDetails: (conversation) => {
      setDetailsOf(conversation.id);
    },
  });
  const path = () => [{ label: t().assistant, href: props.nav.basePath }, ...props.path()];
  // The chat whose details are open, as the list knows it now, so a pin shows at once.
  const detailsChat = () => {
    const id = detailsOf();
    if (!id) return null;
    return (
      props.nav.conversations().find((conversation) => conversation.id === id) ??
      props.nav.placeChats()?.items.find((conversation) => conversation.id === id) ??
      (props.openChat()?.id === id ? props.openChat() : null)
    );
  };
  return (
    <>
      <V2WorkspaceNavigation label={nav.label()} groups={nav.groups()} foot={nav.foot()} />
      <Workspace
        sidebarLabel={v2().sidebarWidth}
        sidebar={<Nav title={t().assistant} icon="moustache" groups={nav.groups()} foot={nav.foot()} />}
        head={
          <Bar
            start={<Path label={t().assistant} items={path()} />}
            end={<Show when={props.openChat()}>{(chat) => <Menu label={v2().chatActions} items={nav.chatMenu(chat())} />}</Show>}
          />
        }
      >
        <Pane.Split>
          <Pane label={v2().chatPane}>
            <Canvas label={v2().chatPane} height="fill">
              <div style={drawing}>{props.main}</div>
            </Canvas>
          </Pane>
          <Show when={props.tabs.open()}>
            <Pane label={v2().tabsPane} detail back={props.tabs.back()} width={{ min: 320, default: 680 }}>
              <Canvas label={v2().tabsPane} height="fill">
                <div style={drawing}>{props.tabs.content}</div>
              </Canvas>
            </Pane>
          </Show>
        </Pane.Split>
      </Workspace>
      <Show when={detailsChat()}>
        {(chat) => (
          <Suspense>
            <ChatDetails
              conversation={chat()}
              project={props.nav.projects().find((project) => project.id === chat().projectId)}
              onClose={() => setDetailsOf(null)}
              onEdit={() => {
                setDetailsOf(null);
                void props.nav.editConversation(chat());
              }}
              onUpdated={props.nav.onConversationUpdated}
            />
          </Suspense>
        )}
      </Show>
    </>
  );
}
