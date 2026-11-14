import { type Accessor, createSignal } from "solid-js";

export type MailComposerTransition = "send" | "discard" | "handoff" | "recovery" | "attachment" | "calendar" | "delivery_options";

type MailComposerTransitionReservation = Readonly<{
  kind: MailComposerTransition;
  token: symbol;
  /** Where the focus was when the step began; it returns there when the step ends without a new place. */
  focus: HTMLElement | null;
}>;

export const createMailComposerTransition = (): {
  active: Accessor<MailComposerTransition | null>;
  reserve: (kind: MailComposerTransition) => MailComposerTransitionReservation | null;
  release: (reservation: MailComposerTransitionReservation) => void;
} => {
  const [current, setCurrent] = createSignal<MailComposerTransitionReservation | null>(null);

  return {
    active: () => current()?.kind ?? null,
    reserve: (kind) => {
      if (current()) return null;
      const active = typeof document === "undefined" ? null : document.activeElement;
      const reservation = {
        kind,
        token: Symbol(kind),
        focus: active !== null && active instanceof HTMLElement && active !== document.body ? active : null,
      };
      setCurrent(reservation);
      return reservation;
    },
    release: (reservation) => {
      if (current()?.token !== reservation.token) return;
      setCurrent(null);
      // A dialog or a control that paused for the step dropped the focus; give it back once controls work again.
      const { focus } = reservation;
      if (focus)
        queueMicrotask(() => {
          const active = document.activeElement;
          if (focus.isConnected && (!active || active === document.body)) focus.focus({ preventScroll: true });
        });
    },
  };
};
