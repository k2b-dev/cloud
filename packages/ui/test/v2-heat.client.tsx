import { render } from "solid-js/web";
import { Bar, Heat, type HeatDay, List, Pane, Row, Text, Workspace } from "../src/v2";
import { addDays } from "../src/v2/behavior/dates";

// The reading column of a mail app while no mail is open: the mails received per day of the last 53 weeks as the
// hero above the sentence of the empty detail. `__k2Heat` picks the data: a usual mailbox, a new one without mail, or
// a huge one with thousands a day. The test reads sizes, tones, keys and the forced-colors look.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Heat?: "usual" | "none" | "huge";
    /** How often the hero was made: once, however often the workspace reads `detailEmpty`. */
    __k2HeroBuilds?: number;
  }
}

const today = "2026-11-27";
const first = "2025-11-24";
// a fixed pattern, no randomness: quiet weekends, busy Mondays, a few days off, one day of a newsletter flood
const usual = (index: number, weekday: number) =>
  weekday >= 5 ? (index % 5 === 0 ? 1 : 0) : index % 29 === 0 ? 0 : index === 200 ? 160 : ((index * 37) % 11) + (weekday === 0 ? 6 : 1);
const days: HeatDay[] =
  window.__k2Heat === "none"
    ? []
    : Array.from({ length: 369 }, (_, index) => {
        const count = usual(index, index % 7);
        return { date: addDays(first, index), count: window.__k2Heat === "huge" ? count * 1234 : count };
      }).filter((day) => day.count > 0);
const number = new Intl.NumberFormat("de-DE");
const counts = new Map(days.map((day) => [day.date, day.count]));
// six in ten of a day's mails came in, the rest went out
const detail = (date: string) => {
  const count = counts.get(date);
  if (!count) return undefined;
  const incoming = Math.ceil(count * 0.6);
  return `${number.format(incoming)} eingehend · ${number.format(count - incoming)} gesendet`;
};

const root = document.getElementById("root");
if (!root) throw new Error("heat: #root is missing");
render(
  () => (
    <Workspace
      detail
      detailEmpty={{
        icon: "mail",
        text: "Keine Nachricht ausgewählt",
        // written inline on purpose: the getter makes the hero on every read, and the workspace must read it once
        hero: (() => {
          window.__k2HeroBuilds = (window.__k2HeroBuilds ?? 0) + 1;
          return (
            <Heat
              days={days}
              today={today}
              label="Mails pro Tag"
              unit={(count) => `${number.format(count)} Mails`}
              detail={detail}
              summary={({ total, days: span }) =>
                total === 0
                  ? "Noch keine Mails in den letzten 12 Monaten"
                  : `${number.format(total)} Mails in den letzten 12 Monaten · Ø ${number.format(Math.round(total / span))} pro Tag`
              }
            />
          );
        })(),
      }}
      head={<Bar start={<Text type="lead">Posteingang</Text>} />}
    >
      <Pane.Split>
        <Pane label="Posteingang" width={{ min: 360, default: 640 }}>
          <List label="Unterhaltungen">
            <Row lines={["Lackfabrik Nordhaus", "Lieferung KW 48"]} end="09:40" />
            <Row lines={["Holzwerk Brandt", "Rechnung November"]} end="Gestern" />
          </List>
        </Pane>
      </Pane.Split>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
