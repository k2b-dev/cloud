import { Composer } from "@k2b/editor/composer";
import { Button, Menu, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";
import type { MailReplyFrameParts } from "../mail-reply-frame";
import type { MailV2Text } from "./mail-v2-messages";

/**
 * The open reply of the v2 pilot: the mockup's composer around Mail's own draft. The head says to whom and from which
 * sender, with Cc and Bcc; the text is Mail's editor; the foot holds the four tools, "More", the status, Discard and
 * Send. Every deed is the composer's own (`MailComposer`): the frame places it and decides nothing.
 *
 * k2b-ui gaps, until v2 has them: no recipient field (Mail's chips stand in the head), no split button (Send later
 * waits under "More"), no pressed or pending state of a button (Formatting and a running Send show only through the
 * text they change and the status), no section heading in a menu (sections stand between lines).
 */
export function MailReplyFrameV2(props: { parts: MailReplyFrameParts; text: MailV2Text }) {
  const parts = () => props.parts;
  return (
    <Composer
      label={parts().label()}
      head={
        <>
          <Menu
            variant="ghost"
            icon={parts().mode.icon()}
            label={parts().mode.label()}
            disabled={parts().mode.disabled?.()}
            items={parts().mode.items()}
          />
          <Text type="meta">{props.text.to}</Text>
          {parts().to}
        </>
      }
      headEnd={
        <>
          {parts().peers}
          <Show when={parts().sender()}>
            {(sender) => (
              <Show when={sender().menu} fallback={<Text type="meta">{props.text.from({ name: sender().text })}</Text>}>
                {(menu) => (
                  <Menu variant="text" label={menu().label()} disabled={menu().disabled?.()} items={menu().items()}>
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
          <Button variant="ghost" icon="paperclip" label={parts().tools.attach.label()} onClick={() => parts().tools.attach.run()} />
          <Show when={parts().tools.signature()}>
            {(signature) => (
              <Menu
                variant="ghost"
                icon="signature"
                label={signature().label()}
                disabled={signature().disabled?.()}
                items={signature().items()}
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
          <Menu variant="ghost" icon="dots" label={parts().tools.more.label()} items={parts().tools.more.items()} />
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
