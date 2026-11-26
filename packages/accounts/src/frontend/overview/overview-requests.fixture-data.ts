// Invented sample requests, shared by the screen fixture and the browser test (plain data, no JSX).
import type { RequestRow } from "../requests/RequestsScreen";

const request = (
  index: number,
  name: string,
  status: RequestRow["status"],
  requested: string,
  comment: string | null = null,
): RequestRow => {
  const [first = name, ...rest] = name.split(" ");
  return {
    id: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name,
    firstName: first,
    email: `${[first, ...rest].join(".").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")}@solberg-kramer.example`,
    status,
    requested,
    comment,
  };
};

/** The first two are pending: the browser test denies them. */
export const REQUESTS: RequestRow[] = [
  request(1, "Jonas Weber", "pending", "25. Nov. 2026", "Neu im Lager ab Dezember"),
  request(2, "Mira Kaya", "pending", "24. Nov. 2026", "Aushilfe im Verkauf, samstags"),
  request(3, "Lena Hartwig", "pending", "23. Nov. 2026"),
  request(4, "Tom Oswald", "pending", "21. Nov. 2026", "Werkstatt, Monteur"),
  request(5, "Sami Yilmaz", "pending", "18. Nov. 2026", "Fotografie für den Katalog"),
  request(6, "Felix Thal", "pending", "16. Nov. 2026"),
  request(7, "Ada Renz", "pending", "12. Nov. 2026", "Buchhaltung, nur lesen"),
  request(8, "Karl Brandt", "pending", "9. Nov. 2026"),
  request(9, "Lars Petersen", "denied", "2. Nov. 2026", "Praktikum"),
  request(10, "Nina Vogt", "completed", "30. Okt. 2026", "Büro"),
  request(11, "Paul Engel", "completed", "28. Okt. 2026"),
  request(12, "Greta Lindqvist", "denied", "20. Okt. 2026", "Kein Bezug zum Betrieb"),
];

/** As the server says it for the pending view of this sample: the oldest and how many wait over a week. */
export const REQUESTS_OLDEST = "9. Nov. 2026";
export const REQUESTS_OVERDUE = 4;
