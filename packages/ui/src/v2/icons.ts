/** A few Tabler icon outlines (MIT, tabler.io), 24 × 24, stroke drawn. Icons are a primitive of their own, never text. */
export const iconPaths = {
  mail: ["M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z", "m3 7 9 6 9-6"],
  inbox: ["M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", "M4 13h3l3 3h4l3-3h3"],
  send: ["M10 14 21 3", "m21 3-6.5 18a.55.55 0 0 1-1 0L10 14l-7-3.5a.55.55 0 0 1 0-1L21 3"],
  draft: ["M14 3v4a1 1 0 0 0 1 1h4", "M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"],
  archive: ["M3 4h18v4H3z", "M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8", "M10 12h4"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "m5 7 1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12", "M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"],
  dots: ["M4 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0", "M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0", "M18 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  pencil: ["M4 20h4L18.5 9.5a2.83 2.83 0 0 0-4-4L4 16v4", "m13.5 6.5 4 4"],
  search: ["M3 10a7 7 0 1 0 14 0a7 7 0 1 0-14 0", "m21 21-6-6"],
  alert: ["M12 9v4", "M10.36 3.6 2.5 17a1.9 1.9 0 0 0 1.64 2.85h15.72A1.9 1.9 0 0 0 21.5 17L13.64 3.6a1.9 1.9 0 0 0-3.28 0z", "M12 16h.01"],
  clip: ["m15 7-6.5 6.5a1.5 1.5 0 0 0 3 3L18 10a3 3 0 0 0-6-6l-6.5 6.5a4.5 4.5 0 0 0 9 9L21 13"],
  next: ["m9 6 6 6-6 6"],
  back: ["m15 6-6 6 6 6"],
  folder: ["M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2"],
  grip: ["M8 5h.01", "M8 12h.01", "M8 19h.01", "M16 5h.01", "M16 12h.01", "M16 19h.01"],
  check: ["m5 12 5 5L20 7"],
  clock: ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0", "M12 7v5l3 3"],
  unread: ["m3 9 9 6 9-6-9-6-9 6", "M21 9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9"],
  reply: ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
  plus: ["M12 5v14", "M5 12h14"],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof iconPaths;
