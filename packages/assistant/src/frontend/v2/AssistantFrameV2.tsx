import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { type Action, Bar, Button, Canvas, Input, Menu, Nav, Pane, Path, Workspace } from "@k2b/ui/v2";
import { type Accessor, createSignal, type JSX, lazy, Show, Suspense } from "solid-js";
import type { AssistantSidebarChat } from "../../sidebar";
import { assistantMessages } from "../messages";
import { useAssistantCopy } from "../ui-copy";
import { type AssistantNavOptions, createAssistantNav } from "./assistant-nav";
import { assistantV2Messages } from "./assistant-v2-messages";

/**
 * The chat and its tabs scroll inside themselves, so they fill the Canvas without asking for their own height.
 * k2b-ui gap: #4407: on the phone a pane with a `Canvas height="fill"` takes `min-height: min-content`, so a drawing as
 * tall as its content (a chat with a long history) grows the pane past the screen and pushes the composer out of view.
 * Laid out from the Canvas's edges, the drawing reports no height of its own and the Canvas keeps the height left.
 */
const drawing = { position: "absolute", inset: "0", display: "flex", "flex-direction": "column", "min-height": "0" } as const;

/** The details of a chat load when someone opens them. */
const ChatDetails = lazy(() => import("./AssistantChatDetailsDialog"));

export type AssistantFrameV2Props = {
  nav: Omit<AssistantNavOptions, "showDetails">;
  /** The chat the page shows, whose deeds stand behind the head's "…"; null on a view or a Project. */
  openChat: Accessor<AssistantSidebarChat | null>;
  /** Opens what belongs to the open chat (files, results, sources) beside it, under the given title. */
  openContext: (title: string) => void;
  /** Where the page stands after "Gustav": the open chat, Project or view. */
  path: Accessor<readonly { label: string; href?: string }[]>;
  newChat: Accessor<Action>;
  /** A list screen (My apps, a Project): on the phone New chat floats as the page's main action (B, look rules). */
  fab?: Accessor<boolean>;
  /** The view has a primary action of its own, such as Save on a settings page. */
  pagePrimary?: Accessor<boolean>;
  /** Further actions of the view in front, in the head before "New chat" (secondary, never a second primary). */
  viewActions?: Accessor<JSX.Element>;
  /** The chat, a Project or a view: the Assistant's own surface, drawn by the shared chat parts. */
  main: JSX.Element;
  /** A view rebuilt on v2 that takes the chat's place, as its own `Pane`; null while the chat (or a v1 view) shows. */
  view: Accessor<(() => JSX.Element) | null>;
  /** The chat's tabs beside it while one is open; on the phone they are the page until the person goes back. */
  tabs: {
    open: Accessor<boolean>;
    /** The tabs are what the person looks at now (the controller's choice), so on the phone they are the page. */
    focused: Accessor<boolean>;
    back: Accessor<Action>;
    content: JSX.Element;
  };
};

/**
 * The Assistant on @k2b/ui v2: the sidebar as `Nav` (and the phone menu); the head with where the page stands, the
 * search of every chat, the open chat's deeds and "New chat", the one way to create; the chat with its tabs beside it.
 * "New chat" stays in the head on the phone instead of floating over the composer. The chat itself,
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
    showDetails: (conversation) => {
      setDetailsOf(conversation.id);
    },
  });
  const path = () => [{ label: t().assistant, href: props.nav.basePath }, ...props.path()];
  const copy = useAssistantCopy();
  const [query, setQuery] = createSignal("");
  const searchKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    nav.search(query().trim());
  };
  // The head's search searches the open Project's chats while one is open, and says so.
  const searchLabel = () => {
    const project = props.nav.projects().find((entry) => entry.id === props.nav.activeProjectId());
    return project ? copy().searchChatsIn({ project: project.name }) : t().searchChats;
  };
  // Read once: the object holds the tabs' content, and Solid makes a prop of JSX a getter, so every read of
  // `props.tabs` would draw that content anew (outside any update, too, when a layout read asks a pane whether it is
  // the detail).
  const tabs = props.tabs;
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
  // The chat and, while one is open, its tabs: the Assistant's working columns.
  const ChatColumns = () => (
    <Pane.Split>
      {/* One pane at a time on the phone and in the panel, as in v1: the pane in front is the detail, and v2 hides the
          other one there (still mounted, so a run or an editor in a tab keeps its state). Beside each other from 768 px. */}
      <Pane label={v2().chatPane} detail={tabs.open() && !tabs.focused()}>
        <Canvas label={v2().chatPane} height="fill">
          {/* The chat's own layout reads its width from this container (`assistant-chat`): from 56 rem the chat's
              context stands beside the timeline, as in v1. */}
          <div class="assistant-chat-pane" style={drawing}>
            {props.main}
          </div>
        </Canvas>
      </Pane>
      <Show when={tabs.open()}>
        <Pane
          label={v2().tabsPane}
          detail={tabs.focused()}
          back={tabs.focused() ? tabs.back() : undefined}
          width={{ min: 320, default: 680 }}
        >
          <Canvas label={v2().tabsPane} height="fill">
            <div style={drawing}>{tabs.content}</div>
          </Canvas>
        </Pane>
      </Show>
    </Pane.Split>
  );
  return (
    <>
      <V2WorkspaceNavigation label={nav.label()} groups={nav.groups()} foot={nav.foot()} />
      <Workspace
        sidebarLabel={v2().sidebarWidth}
        // On the phone the host's bar holds the one search and the head gives way; on a list screen New chat floats
        // instead. A chat (its composer) and a settings page (its foot) have no floating action.
        primary={
          props.fab?.()
            ? { label: props.newChat().label, icon: "plus", disabled: props.newChat().disabled, onClick: () => props.newChat().onClick?.() }
            : undefined
        }
        sidebar={<Nav title={t().assistant} icon="moustache" groups={nav.groups()} foot={nav.foot()} />}
        head={
          <Bar
            // Only a path that says more than the sidebar's "Gustav": a chat, a Project or a view.
            start={props.path().length > 0 ? <Path label={t().assistant} items={path()} /> : undefined}
            end={
              <>
                {/* The search of every chat (of the open Project while one is open). On the phone it folds into the
                    shell's bar, so the page has one search there; Enter opens Cloud's search, as mod+shift+k does.
                    k2b-ui gap (Z2): the head's search should be a symbol that opens over the head on click or "/"
                    (SEARCH + CREATE rule); v2 gives the field a fixed 184 px at 1024, and the bar fold of #4392 keeps
                    it whole beside where the page stands. */}
                <Input
                  type="search"
                  icon="search"
                  label={searchLabel()}
                  placeholder={v2().searchHint}
                  value={query()}
                  onInput={setQuery}
                  onKeyDown={searchKey}
                />
                {props.viewActions?.()}
                <Show when={props.openChat()}>
                  {(chat) => (
                    <Menu
                      label={v2().chatActions}
                      items={[
                        { label: v2().inThisChat, icon: "layout-list", onClick: () => props.openContext(v2().inThisChat) },
                        "separator",
                        ...nav.chatMenu(chat()),
                      ]}
                    />
                  )}
                </Show>
                {/* The one way to create. On a list screen the floating button repeats it on the phone (`floats`);
                    in a chat and on a settings page it stays in the head, where no button floats over the composer.
                    k2b-ui gap: #4406: v2's primary is always blue; Gustav's primary is plum (appearance.primary "ai", rule
                    assistant-no-blue). Lane Y brings it as a platform token; until then no colour of our own. */}
                {/* A page with its own primary (Save on a settings page) keeps New chat secondary: one primary per page. */}
                <Button
                  variant={props.pagePrimary?.() ? "secondary" : "primary"}
                  icon="plus"
                  floats={props.fab?.()}
                  disabled={props.newChat().disabled}
                  onClick={() => props.newChat().onClick?.()}
                >
                  {props.newChat().label}
                </Button>
              </>
            }
          />
        }
      >
        <Show when={props.view()} fallback={<ChatColumns />}>
          {(view) => view()()}
        </Show>
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
