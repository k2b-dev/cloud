import type { OpeningRuleInput, PublicSectionInput, ShiftTemplateInput, VenueInput, VenueTemplateSummary } from "./contracts";
import { venueMessages } from "./messages";

type VenueTemplate = VenueTemplateSummary & {
  venue: VenueInput;
  openingRules: OpeningRuleInput[];
  shifts: ShiftTemplateInput[];
  sections: PublicSectionInput[];
};

const weekdays = [1, 2, 3, 4, 5];

/** Template images ship as static assets of the Venue app. */
const templateImage = (name: string): string => `/public/venue/templates/${name}.jpg`;

const serviceDeskHours = weekdays.map((weekday) => ({
  weekday,
  startTime: "09:00",
  endTime: "17:00",
  note: null,
}));

const serviceDeskShifts = weekdays.flatMap((weekday) => [
  {
    weekday,
    title: "Morning desk",
    startTime: "09:00",
    endTime: "13:00",
    minPeople: 1,
    maxPeople: 2,
    requireTargetForOpening: false,
    active: true,
  },
  {
    weekday,
    title: "Afternoon desk",
    startTime: "13:00",
    endTime: "17:00",
    minPeople: 1,
    maxPeople: 2,
    requireTargetForOpening: false,
    active: true,
  },
]);

const cafeCounterShifts: ShiftTemplateInput[] = [
  ...weekdays.map((weekday) => ({
    weekday,
    title: "Lunch counter",
    startTime: "11:00",
    endTime: "14:00",
    minPeople: 2,
    maxPeople: 4,
    requireTargetForOpening: false,
    active: true,
  })),
  ...weekdays.slice(0, 4).map((weekday) => ({
    weekday,
    title: "Afternoon counter",
    startTime: "14:00",
    endTime: "18:00",
    minPeople: 1,
    maxPeople: 3,
    requireTargetForOpening: false,
    active: true,
  })),
];

export const templates: VenueTemplate[] = [
  {
    id: "service-desk",
    name: "Service desk",
    description: "Weekday public hours, two daily staffing slots, and concise public information.",
    icon: "ti ti-headset",
    venue: {
      name: "Service desk",
      icon: "ti ti-headset",
      slug: "service-desk",
      description: "Public service desk with staffed opening hours.",
      timezone: "Europe/Berlin",
      openMode: "combined",
      signupMode: "both",
      publicEnabled: true,
      feedbackEnabled: true,
      accentColor: "#2563eb",
      logoBase64: null,
      bannerBase64: null,
    },
    openingRules: serviceDeskHours,
    shifts: serviceDeskShifts,
    sections: [
      {
        kind: "markdown",
        title: "Before you visit",
        content: {
          markdown: "Bring the documents relevant to your request. Staff can help during the listed opening hours.",
          text: "Bring the documents relevant to your request. Staff can help during the listed opening hours.",
        },
        enabled: true,
        position: 1,
      },
      {
        kind: "notice",
        title: "Short notice closures",
        content: {
          markdown: "Check this page before visiting. Date-specific closures are shown in the opening status.",
          text: "Check this page before visiting. Date-specific closures are shown in the opening status.",
        },
        enabled: true,
        position: 2,
      },
    ],
  },
  {
    id: "cafe-counter",
    name: "Cafe counter",
    description: "Opening hours, lunch and afternoon shifts, a menu section, and anonymous feedback.",
    icon: "ti ti-cup",
    venue: {
      name: "Cafe counter",
      icon: "ti ti-cup",
      slug: "cafe-counter",
      description: "Counter service with menu, staffing slots, and public status.",
      timezone: "Europe/Berlin",
      openMode: "combined",
      signupMode: "both",
      publicEnabled: true,
      feedbackEnabled: true,
      accentColor: "#059669",
      logoBase64: templateImage("cafe-logo"),
      bannerBase64: templateImage("cafe-banner"),
    },
    openingRules: [
      { weekday: 1, startTime: "11:00", endTime: "18:00", note: null },
      { weekday: 2, startTime: "11:00", endTime: "18:00", note: null },
      { weekday: 3, startTime: "11:00", endTime: "18:00", note: null },
      { weekday: 4, startTime: "11:00", endTime: "18:00", note: null },
      { weekday: 5, startTime: "11:00", endTime: "16:00", note: null },
    ],
    shifts: cafeCounterShifts,
    sections: [
      {
        kind: "menu",
        title: "Menu",
        content: {
          items: [
            {
              name: "Avocado toast",
              description: "Toasted bread with avocado, herbs, and lemon.",
              info: "Contains gluten.",
              price: "4.50 EUR",
              image: templateImage("cafe-avocado-toast"),
            },
            {
              name: "Espresso",
              description: "Short, strong coffee served fresh from the bar.",
              info: "Caffeine.",
              price: "2.20 EUR",
              image: templateImage("cafe-espresso"),
            },
            {
              name: "Cappuccino",
              description: "Espresso with steamed milk and a soft foam top.",
              info: "Contains milk.",
              price: "3.40 EUR",
              image: templateImage("cafe-cappuccino"),
            },
          ],
        },
        enabled: true,
        position: 1,
      },
    ],
  },
];

const localizedTemplate = (template: VenueTemplate, locale?: string): VenueTemplate => {
  const { t } = venueMessages.resolve(locale ? [locale] : []);
  if (template.id === "service-desk") {
    return {
      ...template,
      name: t.templateServiceDesk,
      description: t.templateServiceDeskDescription,
      venue: { ...template.venue, name: t.templateServiceDesk, description: t.templateServiceDeskVenueDescription },
      shifts: template.shifts.map((shift, index) => ({
        ...shift,
        title: index % 2 === 0 ? t.templateMorningDesk : t.templateAfternoonDesk,
      })),
      sections: template.sections.map((section, index) => ({
        ...section,
        title: index === 0 ? t.templateBeforeVisit : t.templateClosures,
        content: {
          markdown: index === 0 ? t.templateBeforeVisitText : t.templateClosuresText,
          text: index === 0 ? t.templateBeforeVisitText : t.templateClosuresText,
        },
      })),
    };
  }
  return {
    ...template,
    name: t.templateCafe,
    description: t.templateCafeDescription,
    venue: { ...template.venue, name: t.templateCafe, description: t.templateCafeVenueDescription },
    shifts: template.shifts.map((shift, index) => ({ ...shift, title: index < 5 ? t.templateLunchCounter : t.templateAfternoonCounter })),
    sections: template.sections.map((section) => ({
      ...section,
      title: t.menu,
      content: {
        ...section.content,
        items: Array.isArray(section.content.items)
          ? section.content.items.map((raw, index) => ({
              ...(raw as Record<string, unknown>),
              ...(index === 0
                ? { name: t.templateAvocadoToast, description: t.templateAvocadoToastDescription, info: t.containsGluten }
                : {}),
              ...(index === 1 ? { description: t.templateEspressoDescription, info: t.caffeine } : {}),
              ...(index === 2 ? { description: t.templateCappuccinoDescription, info: t.containsMilk } : {}),
            }))
          : [],
      },
    })),
  };
};

export const getVenueTemplate = (id: string, locale?: string): VenueTemplate | null => {
  const template = templates.find((entry) => entry.id === id);
  return template ? localizedTemplate(template, locale) : null;
};

export const listVenueTemplates = (locale?: string): VenueTemplateSummary[] =>
  templates.map((template) => {
    const localized = localizedTemplate(template, locale);
    return { id: localized.id, name: localized.name, description: localized.description, icon: localized.icon };
  });
