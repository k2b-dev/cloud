import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import {
  type Action,
  Bar,
  Button,
  Canvas,
  Input,
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
  type StatusFact,
  StatusRow,
  Text,
  useLocale,
  Workspace,
} from "@k2b/ui/v2";
import { type Accessor, For, type JSX, Show, untrack } from "solid-js";
import { chatMessages } from "../../messages";
import { chatV2Messages } from "./chat-v2-messages";

/**
 * k2b-ui gap (Canvas fill, #4223/#4284 not on main): the chat's history scrolls in its own feed and the composer
 * stays at the foot, so the drawing must be exactly as high as its pane. On main a Canvas takes only a height in px.
 * The canvas shrinks to its pane (it clips, so its least height is 0) around a spacer as tall as the screen, and the
 * drawing lies over the whole canvas. Replace both with `<Canvas height="fill">` once it lands.
 */
const spacer = { display: "block", height: "100dvh" } as const;
const drawing = { position: "absolute", inset: "0", display: "flex", "flex-direction": "column", "min-height": "0" } as const;

/** A deed in the head of the open chat: a button, pressed while it is on, turning while it runs. */
export type ChatHeadButton = Action & { pressed?: boolean; busy?: boolean; words?: boolean };

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
  /** The drawing, made once per key. */
  content: () => JSX.Element;
};

export type ChatFrameV2Props = {
  nav: { label: string; groups: readonly NavGroup[]; foot?: readonly NavItem[] };
  newChat: Action;
  search: { value: string; onInput: (value: string) => void; onKeyDown: (event: KeyboardEvent) => void };
  list: {
    lead: string;
    facts?: readonly StatusFact[];
    loading: boolean;
    notices: readonly ChatListNotice[];
    content: JSX.Element;
  };
  detail: Accessor<ChatDetailV2 | null>;
  /** The open chat's info beside it, while the address asks for it. */
  info: Accessor<{ close: Action } | null>;
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
 * Chat on @k2b/ui v2: the places in the sidebar (and the phone's menu); the head with the search and "New chat"; the
 * chats as a list beside the open chat, whose history and composer are Chat's own drawing; the chat's info beside it.
 * On the phone the list is the page, and an open chat is a page of its own with its way back.
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
        detail
        detailEmpty={{ icon: "messages", text: v2().noneOpen }}
        primary={props.newChat}
        sidebar={<Nav title={t().appName} icon="messages" groups={props.nav.groups} foot={props.nav.foot} />}
        head={
          <Bar
            end={
              <>
                {/* k2b-ui gap (Z2): the head's search should be a symbol that opens over the head on click or "/". */}
                <Input
                  type="search"
                  icon="search"
                  label={t().searchChats}
                  placeholder={t().searchChats}
                  value={props.search.value}
                  onInput={props.search.onInput}
                  onKeyDown={props.search.onKeyDown}
                />
                <Button
                  variant="primary"
                  icon={props.newChat.icon}
                  disabled={props.newChat.disabled}
                  onClick={() => props.newChat.onClick?.()}
                >
                  {props.newChat.label}
                </Button>
              </>
            }
          />
        }
      >
        <Pane.Split>
          <Pane
            label={v2().listWidth}
            width={{ min: 300, default: 380 }}
            scrollKey="chat-list"
            status={<StatusRow lead={props.list.lead} facts={props.list.facts} loading={props.list.loading} />}
          >
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
                <Pane
                  detail
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
                  <Canvas label={detail().label}>
                    <span style={spacer} aria-hidden="true" />
                    <div style={drawing}>{content}</div>
                  </Canvas>
                </Pane>
              );
            }}
          </Show>
          <Show when={props.detail() ? props.info() : null}>
            {(info) => (
              // k2b-ui gap (Z2, #4308): on the phone only the pane in front should stand; the info is the page there.
              <Pane
                detail
                label={v2().infoPane}
                width={{ min: 320, default: 360 }}
                back={info().close}
                head={
                  <Bar
                    start={<Text type="lead">{v2().info}</Text>}
                    end={<Button variant="ghost" icon="x" label={info().close.label} onClick={() => info().close.onClick?.()} />}
                  />
                }
              >
                <Canvas label={v2().infoPane}>
                  <span style={spacer} aria-hidden="true" />
                  <div style={drawing}>{props.infoContent()}</div>
                </Canvas>
              </Pane>
            )}
          </Show>
        </Pane.Split>
      </Workspace>
    </>
  );
}
