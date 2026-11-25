import { Composer } from "@k2b/editor/composer";
import { Button, Icon, Menu, type MenuEntry, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";
import type { MailReplyFrameChoice, MailReplyFrameParts } from "../mail-reply-frame";
import type { MailV2Text } from "./mail-v2-messages";

/**
 * The open reply of the v2 pilot: the mockup's composer around Mail's own draft. The head says to whom and from which
 * sender, with Cc and Bcc; the text is Mail's editor; the foot holds the four tools, "More", the status, Discard and
 * Send. Every deed is the composer's own (`MailComposer`): the frame places it and decides nothing.
 *
 * k2b-ui gaps, until v2 has them: no recipient field (Mail's chips stand in the head), no split button (Send later
 * waits under "More"), no pressed or pending state of a button (Formatting and a running Send show only through the
 * text they change and the status).
 */
export function MailReplyFrameV2(props: { parts: MailReplyFrameParts; text: MailV2Text }) {
  const parts = () => props.parts;
  /** One choice under its heading: the chosen option carries the tick, a choice closes the menu. */
  const choice = (title: string, of: MailReplyFrameChoice): MenuEntry[] => [
    { title, choice: of.value(), onChoose: (value) => of.choose(value), items: of.options() },
  ];
  /** Reply, Reply all, Forward or the internal note, as one choice at the top of "More"; it waits while the mode switches. */
  const modeChoice = (): MenuEntry[] => {
    const mode = parts().mode;
    const waits = mode.disabled?.() ?? false;
    return choice(props.text.replyAs, { ...mode, options: () => mode.options().map((option) => ({ ...option, disabled: waits })) });
  };
  return (
    <Composer
      label={parts().label()}
      head={
        <>
          {/* The row of the resting composer, unchanged: the mode's symbol, "To", the recipient. The mode is a choice in
              "More" (and Reply, Reply all, Forward stand in each message's menu), so nothing in the row moves. */}
          <Icon name={parts().mode.icon()} tone="muted" />
          <Text type="meta">{props.text.to}</Text>
          {parts().to}
        </>
      }
      headEnd={
        <>
          {parts().peers}
          <Show when={parts().sender()}>
            {(sender) => (
              <Show when={sender().choice} fallback={<Text type="meta">{props.text.from({ name: sender().text })}</Text>}>
                {(senders) => (
                  <Menu
                    variant="text"
                    label={senders().label()}
                    disabled={senders().disabled?.()}
                    items={choice(props.text.sender, senders())}
                  >
                    {props.text.from({ name: sender().text })}
                  </Menu>
                )}
              </Show>
            )}
          </Show>
          <Show when={!parts().ccShown()}>
            <Button variant="text" disabled={!parts().editable()} onClick={() => parts().showCc()}>
              Cc
            </Button>
            <Button variant="text" disabled={!parts().editable()} onClick={() => parts().showCc()}>
              Bcc
            </Button>
          </Show>
        </>
      }
      tools={
        <>
          <Show when={parts().tools.formatting()}>
            {(formatting) => (
              <Button
                variant="ghost"
                icon="typography"
                label={formatting().label}
                disabled={formatting().disabled}
                onClick={() => formatting().toggle()}
              />
            )}
          </Show>
          <Button
            variant="ghost"
            icon="paperclip"
            label={parts().tools.attach.label()}
            disabled={parts().tools.attach.disabled()}
            onClick={() => parts().tools.attach.run()}
          />
          <Show when={parts().tools.signature()}>
            {(signature) => (
              <Menu
                variant="ghost"
                icon="signature"
                label={signature().label()}
                disabled={signature().disabled?.()}
                items={choice(props.text.signature, signature())}
              />
            )}
          </Show>
          <Button
            variant="ghost"
            icon="sparkles"
            label={parts().tools.assistant.label()}
            disabled={parts().tools.assistant.disabled()}
            onClick={() => parts().tools.assistant.run()}
          />
          <Menu variant="ghost" icon="dots" label={parts().tools.more.label()} items={[...modeChoice(), ...parts().tools.more.items()]} />
        </>
      }
      actions={
        <>
          {parts().status}
          <Button
            variant="ghost"
            icon="trash"
            label={parts().discard.label()}
            disabled={parts().discard.disabled()}
            onClick={() => parts().discard.run()}
          />
          <Button
            variant="primary"
            icon="send"
            disabled={parts().send.disabled()}
            title={parts().send.blocked() ?? undefined}
            onClick={() => parts().send.run()}
          >
            {parts().send.label()}
          </Button>
        </>
      }
    >
      {parts().top}
      {parts().body}
      {parts().hint}
    </Composer>
  );
}
