import { describe, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import "../../ssr-test-plugin";
import type { PublicSection, PublicStatus } from "../../../contracts";
import { cafe, guestStates, saturdayAt, statusAt } from "./guest-page.browser-fixture";

const { GuestPage, GuestUnavailable, linkTarget } = await import("./guest-page");
const { formatPhone } = await import("../../../phone-format");
const { GuestFeedbackPage } = await import("./feedback/guest-feedback-page");

const render = (locale: string, content: () => JSX.Element) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return content();
      },
    }),
  );
const guest = (status: PublicStatus, locale = "de") =>
  render(locale, () => createComponent(GuestPage, { status, feedbackUrl: `/app/venue/public/${status.venue.id}/feedback` }));
const feedback = (status: PublicStatus | null) =>
  render("de", () => createComponent(GuestFeedbackPage, { status, backUrl: "/app/venue/public/Cafe01" }));

const text = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

/** The hero's words: what stands in the main column before the first section. */
const hero = (status: PublicStatus, locale = "de") => {
  const words = text(guest(status, locale));
  const first = status.sections[0]?.title;
  return words.slice(words.indexOf(status.venue.name) + status.venue.name.length, first ? words.indexOf(first) : undefined).trim();
};

describe("Venue guest page: the hero says now in one statement", () => {
  test("open: until when, and what comes after a closed tomorrow", () => {
    expect(hero(guestStates.open())).toBe("Bewerten Geöffnet bis 15:00 Morgen geschlossen · Montag ab 08:00");
  });

  test("opens later today: when, today's window and the next day", () => {
    expect(hero(guestStates.later())).toBe("Bewerten Öffnet um 10:00 Heute 10:00–15:00 · Montag ab 08:00");
  });

  test("closed for the day: when it opens next, with its date", () => {
    expect(hero(guestStates.closed())).toBe("Bewerten Geschlossen Öffnet Montag, 30. Nov. um 08:00");
  });

  test("a closure today names the hours it replaces and its reason", () => {
    expect(hero(guestStates.exception())).toBe("Bewerten Heute geschlossen Statt 10:00–15:00 · Inventur Öffnet Montag, 30. Nov. um 08:00");
  });

  test("a special opening today, an end at midnight, and the next open day after a closed one", () => {
    expect(hero(guestStates.worst())).toStartWith(
      "Bewerten Geöffnet bis 23:00 Sonderöffnung 18:00–23:00 · Lange Nacht der Wissenschaften – mit Live-Musik im Innenhof und Führungen durch das Haus Morgen 10:00–13:00",
    );
    // the bar's Wednesday is a private party: the next opening is Thursday, and its night ends at 24:00
    expect(hero(guestStates.bar())).toBe("Bewerten Öffnet um 20:00 Heute 20:00–24:00 · Donnerstag ab 20:00");
    expect(hero(statusAt(cafe, saturdayAt("14:00"), { sections: [] }))).toStartWith("Bewerten Geöffnet bis 15:00");
  });

  test("a venue without hours says once that nothing is planned", () => {
    const none = statusAt({ ...cafe, rules: [], changes: [] }, saturdayAt("12:00"));
    const words = text(guest(none));
    expect(words.split("In den nächsten zwei Wochen ist keine Öffnung geplant.").length - 1).toBe(1);
    expect(words).not.toContain("Öffnungszeiten");
    expect(words).not.toContain("Geänderte Zeiten");
  });

  test("speaks English on an English request", () => {
    expect(hero(guestStates.open(), "en")).toBe("Rate Open until 15:00 Closed tomorrow · Monday from 08:00");
    expect(hero(guestStates.closed(), "en")).toBe("Rate Closed Opens Monday, Nov 30 at 08:00");
  });
});

describe("Venue guest page: content and facts", () => {
  test("reads the hero, the sections in the admin's order, then the week and the changed hours", () => {
    const status = guestStates.open();
    const words = text(guest(status));
    const places = ["Geöffnet", ...status.sections.map((section) => section.title), "Öffnungszeiten", "Geänderte Zeiten"].map((title) =>
      words.indexOf(title),
    );
    expect(places.every((place) => place >= 0)).toBe(true);
    expect(places).toEqual(places.toSorted((a, b) => a - b));
    expect(words).toContain("Linsen-Dal mit Basmatireis Rote Linsen, Kokosmilch, frischer Koriander · vegan · Allergene: 9 4,20 €");
    expect(words).toContain("Montag 08:00–18:00");
    expect(words).toContain("Sonntag Geschlossen");
  });

  test("the changed hours start tomorrow: today stands in the hero only", () => {
    const words = text(guest(guestStates.worst()));
    expect(words.split("Lange Nacht der Wissenschaften").length - 1).toBe(1);
    expect(words).toContain("Mo., 30. Nov. Grundreinigung Geschlossen");
    expect(words).toContain("Mi., 9. Dez. Frühstück für Erstsemester 08:00–10:00");
    // today's row shows the special opening instead of the regular Saturday
    expect(words).toContain("Samstag 18:00–23:00");
    expect(words).toContain("Montag Mittagstisch 11:30–14:00 17:00–22:00");
  });

  test("a day with a break draws both windows on its track, a closed day none", () => {
    const html = guest(guestStates.breaks());
    const bars = (html.match(/data-k2-part="RangeBar"[^>]*>([\s\S]*?)<\/span>/g) ?? []).map((bar) => bar.match(/<i /g)?.length ?? 0);
    // Monday to Thursday with a break, Friday and Saturday whole, Sunday closed
    expect(bars).toEqual([2, 2, 2, 2, 1, 1, 0]);
  });

  test("a closure today marks today's row in warn", () => {
    const html = guest(guestStates.exception());
    expect(html).toMatch(/aria-current="true"[\s\S]*?Samstag[\s\S]*?data-tone="warn"[^>]*>Geschlossen</);
  });

  test("links lead only where visitors can follow them, each with the sign of its kind", () => {
    const links: PublicSection = {
      ...cafe.sections.at(-1)!,
      content: {
        links: [
          { label: "Sneaky", href: "javascript:alert(1)" },
          { label: "Bare host", href: "www.cafe.example.org" },
          { label: "Formular", href: "/app/grids/forms/Form01" },
          { label: "Anrufen", href: "tel:+493012345678" },
        ],
      },
    };
    const html = guest(statusAt({ ...cafe, sections: [links] }, saturdayAt("12:00")));
    expect(html).toContain('href="/app/grids/forms/Form01"');
    expect(html).toContain('href="tel:+493012345678"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Sneaky");
    expect(html).not.toContain("Bare host");
    expect(html).toContain("ti-phone");
  });

  test("the venue's description stands under the hero", () => {
    const words = text(guest(guestStates.worst()));
    expect(words.indexOf("Café am Tag, Bar am Abend")).toBeGreaterThan(words.indexOf("Morgen 10:00–13:00"));
  });

  test("“Rate” leads to the feedback page and leaves while the venue takes no feedback", () => {
    expect(guest(guestStates.open())).toMatch(/<a[^>]*href="\/app\/venue\/public\/Cafe01\/feedback"[^>]*>[\s\S]*?Bewerten/);
    expect(text(guest(guestStates.nofeedback()))).not.toContain("Bewerten");
  });

  test("the guest page is no island: it reads without a script", () => {
    for (const state of ["open", "worst", "nosections"] as const) expect(guest(guestStates[state]())).not.toContain("solid-island");
    expect(render("de", () => createComponent(GuestUnavailable, {}))).not.toContain("solid-island");
  });

  test("an unknown venue shows the page that reveals nothing, with the way to Venues", () => {
    const words = text(render("de", () => createComponent(GuestUnavailable, {})));
    expect(words).toContain("Diese Seite ist nicht verfügbar");
    expect(words).toContain("Standorte öffnen");
  });
});

describe("Venue guest page: what a link row names", () => {
  test("a site, with the one path step that names an account; mail and Cloud paths as they are", () => {
    expect(linkTarget("https://instagram.example/campuscafenord")).toBe("instagram.example/campuscafenord");
    expect(linkTarget("https://campus.example.org/lageplan/n2")).toBe("campus.example.org");
    expect(linkTarget("https://kellerbar.example.org/")).toBe("kellerbar.example.org");
    expect(linkTarget("mailto:cafe-nord@example.org")).toBe("cafe-nord@example.org");
    expect(linkTarget("/app/grids/forms/Form01")).toBe("/app/grids/forms/Form01");
  });

  test("a phone number reads as the server writes it, and as stored without a writer", () => {
    expect(linkTarget("tel:+493012345678", formatPhone)).toBe("+49 30 12345678");
    expect(linkTarget("tel:+493012345678")).toBe("+493012345678");
    const status = guestStates.open();
    const html = render("de", () => createComponent(GuestPage, { status, feedbackUrl: "/x", phone: formatPhone }));
    expect(text(html)).toContain("Anrufen +49 30 12345678");
  });
});

describe("Venue feedback page", () => {
  test("the form is the page's one island, and it carries only the venue's id, name and way back", () => {
    const html = feedback(guestStates.open());
    expect(html.match(/<solid-island/g)?.length).toBe(1);
    const props = html.match(/data-props="([^"]*)"/)?.[1] ?? "";
    expect(props.length).toBeLessThan(600);
    const words = text(html);
    expect(words).toContain("Wie war dein Besuch?");
    expect(words).toContain("Wähle 1 bis 5 Sterne.");
    expect(words).toContain("Höchstens 2.000 Zeichen.");
    expect(html).toContain('maxlength="2000"');
    expect(html).toContain('data-k2-part="Rating"');
    expect(html).toMatch(/<input[^>]*name="rating"/);
  });

  test("a venue that takes no feedback says so without a form, with the way back to its page", () => {
    const closed = { ...guestStates.open(), venue: { ...guestStates.open().venue, feedbackEnabled: false } };
    const html = feedback(closed);
    expect(html).not.toContain("solid-island");
    expect(text(html)).toContain("Feedback ist gerade geschlossen: Campus-Café Nord nimmt im Moment keine Bewertungen an.");
    expect(html).toMatch(/href="\/app\/venue\/public\/Cafe01"[^>]*>[\s\S]*?Campus-Café Nord ansehen/);
  });

  test("an unknown venue shows the page that reveals nothing", () => {
    expect(text(feedback(null))).toContain("Diese Seite ist nicht verfügbar");
  });
});
