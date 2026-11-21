import { clipboard } from "@k2b/stdlib/browser";
import { Button, ButtonLink, toast } from "@k2b/ui";
import { For, Show } from "solid-js";
import { usePulseMessages } from "../use-messages";

/**
 * A base that is not shared with the person: the head already says "No access"; below stands only who gives access,
 * the people who manage the base (decided 17.10.), and the link to send them. The base's name never shows.
 */
export default function NoAccessView(props: { managers: string[] }) {
  const t = usePulseMessages();
  const copy = () =>
    void clipboard.copy(window.location.href).then(
      () => toast.success(t().linkCopied),
      () => toast.error(t().copySetupFailed, { title: t().copyLinkFailed }),
    );
  return (
    <section class="pulse-tab pulse-no-access" aria-label={t().noAccess}>
      <p class="pulse-no-access__lead">{t().noAccessLead}</p>
      <p class="pulse-line">
        <Show when={props.managers.length} fallback={t().noAccessNobody}>
          {(() => {
            const [before, after] = t().noAccessManagers({ names: "\u0000" }).split("\u0000");
            return (
              <>
                {before}
                <For each={props.managers}>
                  {(name, index) => (
                    <>
                      <Show when={index() > 0}> {index() === props.managers.length - 1 ? t().or : ","} </Show>
                      <strong>{name}</strong>
                    </>
                  )}
                </For>
                {after}
              </>
            );
          })()}
        </Show>
      </p>
      <div class="pulse-no-access__actions">
        <Button variant="secondary" size="sm" onClick={copy}>
          <i class="ti ti-copy" aria-hidden="true" />
          {t().copyLink}
        </Button>
        <ButtonLink class="pulse-phone-only" variant="secondary" size="sm" href="/app/pulse">
          {t().toMyBases}
        </ButtonLink>
      </div>
    </section>
  );
}
