import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import {
  type Action,
  Bar,
  Button,
  Canvas,
  Menu,
  type MenuEntry,
  Nav,
  type NavGroup,
  type NavItem,
  Notice,
  Pane,
  type Person,
  RecordHead,
  type RecordId,
  Text,
  useLocale,
  Workspace,
} from "@k2b/ui/v2";
import { type Accessor, For, type JSX, Show, untrack } from "solid-js";
import { chatMessages } from "../../messages";
import { chatV2Messages } from "./chat-v2-messages";

/** Chat's own drawing (history and composer, the info) is a column that fills the pane; its history scrolls inside. */
const drawing = { display: "flex", "flex-direction": "column", "min-height": "0", "min-width": "0" } as const;

/** A deed in the head of the open chat: a button, pressed while it is on, turning while it runs. */
export type ChatHeadButton = Action & { pressed?: boolean; busy?: boolean; words?: boolean; keep?: boolean };

/** A line about the list that needs the person: something failed, with its way out. */
export type ChatListNotice = { tone: "bad" | "warn"; text: string; action?: Action };

/** What stands beside the list: an open chat, or one of Chat's pages (For you, channels, a chat's threads). */
export type ChatDetailV2 = {
  /** One detail per chat or page: a new key starts the drawing afresh. */
  key: string;
  label: string;
  /** The open thing's face in the detail's head. */
  head: { name: string; avatar?: Person; kinds?: readonly string[]; ids?: readonly RecordId[] };
  /** The way back to the list on the phone. */
  back: Action;
  /** The part of the chat that shows, as a choice with words (the threads). */
  picker?: { label: string; name: string; items: readonly MenuEntry[] };
  buttons?: readonly ChatHeadButton[];
  /** The rest of the deeds behind "…". */
  menu?: readonly MenuEntry[];
  /** What the pane shows, made once per key. */
  content: () => JSX.Element;
  /** The content is Chat's own drawing (the history and composer), drawn in a `Canvas` that fills the pane; `false` for a page built of v2 parts. */
  drawing?: boolean;
};

export type ChatFrameV2Props = {
  nav: { label: string; groups: readonly NavGroup[]; foot?: readonly NavItem[] };
  newChat: Action;
  search: { value: string; onInput: (value: string) => void; onKeyDown: (event: KeyboardEvent) => void };
  list: {
    notices: readonly ChatListNotice[];
    content: JSX.Element;
  };
  detail: Accessor<ChatDetailV2 | null>;
  /** The open chat's info beside it, while the address asks for it. */
  info: Accessor<{ close: Action; back: Action; menu: readonly MenuEntry[] } | null>;
  /** The info itself, made once while it stands. */
  infoContent: () => JSX.Element;
};

const HeadButton = (props: { button: ChatHeadButton }) => (
  <Show
    when={props.button.words}
    fallback={
      <Button
        variant="ghost"
        icon={props.button.icon}
        label={props.button.label}
        href={props.button.href}
        onNavigate={props.button.onNavigate}
        onClick={() => props.button.onClick?.()}
        pressed={props.button.pressed}
        keep={props.button.keep}
        busy={props.button.busy}
        disabled={props.button.disabled}
      />
    }
  >
    <Button
      icon={props.button.icon}
      href={props.button.href}
      onNavigate={props.button.onNavigate}
      onClick={() => props.button.onClick?.()}
      pressed={props.button.pressed}
      busy={props.button.busy}
      disabled={props.button.disabled}
    >
      {props.button.label}
    </Button>
  </Show>
);

/**
 * Chat on @k2b/ui v2: the places in the sidebar (and the phone's menu) under Chat's search and "New chat", with no
 * head bar of its own (Valentin, v8); the chats as a list beside the open chat, whose history and composer are Chat's
 * own drawing; the chat's info beside it. On the phone the list is the page, "New chat" floats over it, and an open
 * chat is a page of its own with its way back.
 */
export default function ChatFrameV2(props: ChatFrameV2Props): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const v2 = () => chatV2Messages.resolve([locale()]).t;
  return (
    <>
      <V2WorkspaceNavigation label={props.nav.label} groups={props.nav.groups} foot={props.nav.foot} />
      <Workspace
        sidebarLabel={v2().sidebarWidth}
        // The chat keeps room to read: where list, chat and sidebar do not fit (a tablet), the sidebar is a drawer.
        // The chat, or its info while open, keeps room to read: where it does not fit, the sidebar becomes a drawer.
        detail={520}
        detailEmpty={{ icon: "messages", text: v2().noneOpen }}
        // On the phone the main action floats over the list only; in an open chat it would cover the composer.
        primary={props.detail() ? undefined : props.newChat}
        sidebar={
          <Nav
            title={t().appName}
            icon="messages"
            search={{
              label: t().searchChats,
              value: props.search.value,
              onInput: props.search.onInput,
              onKeyDown: props.search.onKeyDown,
            }}
            primary={props.newChat}
            groups={props.nav.groups}
            foot={props.nav.foot}
          />
        }
      >
        <Pane.Split>
          <Pane label={v2().listWidth} width={{ min: 300, default: 380 }} scrollKey="chat-list">
            <For each={props.list.notices}>
              {(notice) => (
                <Notice tone={notice.tone} actions={notice.action ? [notice.action] : undefined}>
                  {notice.text}
                </Notice>
              )}
            </For>
            {props.list.content}
          </Pane>
          <Show when={props.detail()?.key} keyed>
            {(_key) => {
              // The head follows the open chat; the drawing stays for as long as the key does.
              const detail = () => props.detail() ?? fallback;
              const fallback = untrack(() => props.detail())!;
              const content = untrack(() => fallback.content());
              return (
                // While its info is open, the info is the detail: on the phone it is the page and the chat gives way,
                // and beside the chat on a wide screen.
                <Pane
                  detail={!props.info()}
                  // Beside its info the chat keeps a reading width of its own; where list, chat and info do not fit
                  // with the sidebar, the sidebar becomes a drawer.
                  width={props.info() ? { min: 440, default: 560 } : undefined}
                  label={detail().label}
                  back={detail().back}
                  head={
                    <Bar
                      start={
                        <RecordHead
                          name={detail().head.name}
                          avatar={detail().head.avatar}
                          kinds={detail().head.kinds}
                          ids={detail().head.ids}
                        />
                      }
                      end={
                        <>
                          <Show when={detail().picker}>
                            {(picker) => (
                              <Menu label={picker().label} items={picker().items}>
                                {picker().name}
                              </Menu>
                            )}
                          </Show>
                          <For each={detail().buttons}>{(button) => <HeadButton button={button} />}</For>
                          <Show when={detail().menu?.length}>
                            <Menu label={v2().chatActions} items={detail().menu ?? []} />
                          </Show>
                        </>
                      }
                    />
                  }
                >
                  <Show when={fallback.drawing !== false} fallback={content}>
                    <Canvas label={detail().label} height="fill">
                      <div style={drawing}>{content}</div>
                    </Canvas>
                  </Show>
                </Pane>
              );
            }}
          </Show>
          <Show when={props.detail() ? props.info() : null}>
            {(info) => (
              // The info is the detail while it is open: beside the chat on a wide screen, the page on the phone, with its
              // way back to the chat.
              <Pane
                detail
                side
                label={v2().infoPane}
                width={{ min: 360, default: 520 }}
                back={info().back}
                head={
                  <Bar
                    start={<Text type="lead">{v2().info}</Text>}
                    end={
                      <>
                        <Show when={info().menu.length > 0}>
                          <Menu label={v2().chatActions} items={info().menu} />
                        </Show>
                        <Button variant="ghost" icon="x" label={info().close.label} onClick={() => info().close.onClick?.()} />
                      </>
                    }
                  />
                }
              >
                {props.infoContent()}
              </Pane>
            )}
          </Show>
        </Pane.Split>
      </Workspace>
    </>
  );
}
