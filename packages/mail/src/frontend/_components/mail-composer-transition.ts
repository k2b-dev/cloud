import { type Accessor, createSignal } from "solid-js";

export type MailComposerTransition = "send" | "discard" | "handoff" | "recovery" | "attachment" | "calendar" | "delivery_options";

type MailComposerTransitionReservation = Readonly<{
  kind: MailComposerTransition;
  token: symbol;
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
      const reservation = { kind, token: Symbol(kind) };
      setCurrent(reservation);
      return reservation;
    },
    release: (reservation) => {
      if (current()?.token === reservation.token) setCurrent(null);
    },
  };
};
