import { Composer } from "@k2b/editor/composer";
import { Button, Icon, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";
import type { MailReplyFrameMenu, MailReplyFrameParts } from "../mail-reply-frame";
import type { MailV2Text } from "./mail-v2-messages";

/**
 * The open reply of the v2 pilot: the mockup's composer around Mail's own draft. The head says to whom and from which
 * sender, with Cc and Bcc; the text is Mail's editor; the foot holds the four tools, "More", the status, Discard and
 * Send. Every deed is the composer's own (`MailComposer`): the frame places it and decides nothing.
 *
 * k2b-ui gaps, until v2 has them: no recipient field (Mail's chips stand in the head), no menu (#4109; the composer
 * opens v1's menu beside the v2 button), no split button (Send later waits under "More"), no pressed or pending
 * state of a button (Formatting and a running Send show only through the text they change and the status).
 */
export function MailReplyFrameV2(props: { parts: MailReplyFrameParts; text: MailV2Text }) {
  const parts = () => props.parts;
  const menuButton = (menu: MailReplyFrameMenu, place: "head" | "foot") => (event: MouseEvent) => {
    if (event.currentTarget instanceof HTMLElement) parts().openMenu(menu, event.currentTarget, place);
  };
  return (
    <Composer
      label={parts().label()}
      head={
        <>
          <Button
            variant="ghost"
            icon={parts().mode.icon()}
            label={parts().mode.label()}
            menu
            disabled={parts().mode.disabled?.()}
            onClick={menuButton(parts().mode, "head")}
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
                  <Button variant="text" menu disabled={menu().disabled?.()} onClick={menuButton(menu(), "head")}>
                    {props.text.from({ name: sender().text })}
                  </Button>
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
              <Button
                variant="ghost"
                icon="signature"
                label={signature().label()}
                disabled={signature().disabled?.()}
                onClick={menuButton(signature(), "foot")}
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
          <Button variant="ghost" icon="dots" label={parts().tools.more.label()} onClick={menuButton(parts().tools.more, "foot")} />
        </>
      }
      actions={
        <>
          <span role="status" aria-live="polite">
            <Show when={parts().status()}>
              {(status) => (
                <>
                  <Icon name={status().icon} tone="muted" />
                  <Text type="meta">{status().text}</Text>
                </>
              )}
            </Show>
          </span>
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
