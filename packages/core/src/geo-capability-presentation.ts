export const geoCapabilityPresentation = {
  "address.autocomplete": {
    title: "Adressen vorschlagen",
    description:
      "Liefert bis zu 5 Adressvorschläge für 3–300 Zeichen. Ergebnisse tragen Herkunft; Namensnennung beibehalten. Cache-Treffer sind kostenlos, sonst Credits im Betreiberbudget.",
  },
  "address.geocode": {
    title: "Adresse verorten",
    description:
      "Verortet eine Adresse aus höchstens 300 Zeichen oder Feldern bis 200 Zeichen. Fragt 5 Anbieterkandidaten an; plausibel ist eine Konfidenz ≥ 0,5. Liefert eine Adresse, bei Mehrdeutigkeit bis zu 5 Kandidaten oder meldet keinen Treffer. Herkunft und Namensnennung beibehalten; Credits im Betreiberbudget.",
  },
  "address.reverse": {
    title: "Adresse zu Koordinaten finden",
    description:
      "Liefert eine Adresse zu Breiten- und Längengrad. Herkunft und Namensnennung beibehalten; Credits im Betreiberbudget, Cache-Treffer kostenlos.",
  },
  "place.search": {
    title: "Orte suchen",
    description:
      "Liefert bis zu 20 Orte aus höchstens 5 Kategorien nahe einem Punkt, im Kreis/Rechteck oder entlang polyline6. Routenfenster höchstens 200 km, Puffer 100–5.000 m. Herkunft und Namensnennung beibehalten; Credits im Betreiberbudget.",
  },
  "geo.availability": {
    title: "Geo-Verfügbarkeit prüfen",
    description: "Zeigt Einrichtung, persönliche und Cloud-Budgetgrenzen und deren Rücksetzzeit. Kostenlos, ohne Anbieteraufruf.",
  },
};
