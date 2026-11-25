// Invented sample requests, shared by the screen fixture and the browser test (plain data, no JSX).
import type { RequestRow } from "../requests/RequestsScreen";

export const REQUESTS: RequestRow[] = [
  {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    name: "Jonas Weber",
    firstName: "Jonas",
    email: "jonas.weber@solberg-kramer.example",
    status: "pending",
    requested: "20. Nov. 2026",
    comment: "Neu im Lager ab Dezember",
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    name: "Mira Kaya",
    firstName: "Mira",
    email: "mira.kaya@solberg-kramer.example",
    status: "pending",
    requested: "18. Nov. 2026",
    comment: null,
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000003",
    name: "Lars Petersen",
    firstName: "Lars",
    email: "lars@solberg-kramer.example",
    status: "denied",
    requested: "02. Nov. 2026",
    comment: "Praktikum",
  },
];
