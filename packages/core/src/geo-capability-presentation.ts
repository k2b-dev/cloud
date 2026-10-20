const areaInput = {
  area: "Optionales geografisches Suchgebiet als Rechteck oder Kreis.",
  "area.type": "Art des Suchgebiets: bbox für ein Rechteck oder circle für einen Kreis.",
  "area.west": "Westlicher Längengrad des Rechtecks.",
  "area.south": "Südlicher Breitengrad des Rechtecks.",
  "area.east": "Östlicher Längengrad des Rechtecks.",
  "area.north": "Nördlicher Breitengrad des Rechtecks.",
  "area.point": "Mittelpunkt des Kreises.",
  "area.point.lat": "Breitengrad des Kreismittelpunkts in Grad, −90 bis 90.",
  "area.point.lon": "Längengrad des Kreismittelpunkts in Grad, −180 bis 180.",
  "area.radiusMeters": "Positiver Radius des Kreises in Metern.",
};

export const geoCapabilityPresentation = {
  "address.autocomplete": {
    title: "Adressen vorschlagen",
    description:
      "Liefert bis zu 5 Adressvorschläge für 3–300 Zeichen. Ergebnisse tragen Herkunft; Namensnennung beibehalten. Cache-Treffer sind kostenlos, sonst Credits im Betreiberbudget.",
    input: {
      text: "Adressanfang mit 3–300 Zeichen.",
      limit: "Höchstens 5 Vorschläge; ohne Angabe 5.",
      countryCode: "Optionaler ISO-Ländercode mit zwei Buchstaben zum Filtern der Ergebnisse.",
      type: "Optionaler Ergebnistyp, etwa city für einen Ort oder street für eine Straße.",
      bias: "Optionaler Punkt, dessen Nähe die Reihenfolge der Vorschläge beeinflusst.",
      "bias.lat": "Breitengrad in Grad, −90 bis 90.",
      "bias.lon": "Längengrad in Grad, −180 bis 180.",
      ...areaInput,
    },
  },
  "address.geocode": {
    title: "Adresse verorten",
    description:
      "Verortet eine Adresse aus höchstens 300 Zeichen oder Feldern bis 200 Zeichen. Fragt 5 Anbieterkandidaten an; plausibel ist eine Konfidenz ≥ 0,5. Liefert eine Adresse, bei Mehrdeutigkeit bis zu 5 Kandidaten oder meldet keinen Treffer. Herkunft und Namensnennung beibehalten; Credits im Betreiberbudget.",
    input: {
      text: "Adresssuche als Text mit höchstens 300 Zeichen; entweder text oder fields verwenden.",
      fields: "Strukturierte Adresse mit höchstens 200 Zeichen je Feld; entweder fields oder text verwenden.",
      "fields.line1": "Straße und Hausnummer mit höchstens 200 Zeichen.",
      "fields.postalCode": "Postleitzahl mit höchstens 200 Zeichen.",
      "fields.city": "Ort mit höchstens 200 Zeichen.",
      "fields.stateRegion": "Bundesland oder Region mit höchstens 200 Zeichen.",
      "fields.country": "Ländername mit höchstens 200 Zeichen.",
      countryCode: "Optionaler ISO-Ländercode mit zwei Buchstaben zum Filtern der Ergebnisse.",
    },
  },
  "address.reverse": {
    title: "Adresse zu Koordinaten finden",
    description:
      "Liefert eine Adresse zu Breiten- und Längengrad. Herkunft und Namensnennung beibehalten; Credits im Betreiberbudget, Cache-Treffer kostenlos.",
    input: {
      point: "Koordinaten, zu denen eine Adresse gesucht wird.",
      "point.lat": "Breitengrad in Grad, −90 bis 90.",
      "point.lon": "Längengrad in Grad, −180 bis 180.",
    },
  },
  "place.search": {
    title: "Orte suchen",
    description:
      "Liefert bis zu 20 Orte aus höchstens 5 Kategorien nahe einem Punkt, im Kreis/Rechteck oder entlang polyline6. Routenfenster höchstens 200 km, Puffer 100–5.000 m. Bei truncated: true das Routenfenster verkleinern; ein leeres Ergebnis schließt dann Treffer nicht aus. Herkunft und Namensnennung beibehalten; Credits im Betreiberbudget.",
    input: {
      categories: "1–5 Ortskategorien aus dem Cloud-Vertrag.",
      near: "Punkt zum Sortieren nach Entfernung; genau eine Option aus near, area oder along wählen.",
      "near.lat": "Breitengrad in Grad, −90 bis 90.",
      "near.lon": "Längengrad in Grad, −180 bis 180.",
      ...areaInput,
      along: "Suchkorridor entlang eines Routenabschnitts von höchstens 200 km.",
      "along.polyline6": "Vollständige Route als polyline6 mit höchstens 102.400 ASCII-Zeichen.",
      "along.fromKm": "Anfang des Suchabschnitts in Kilometern ab dem Start der vollständigen Route.",
      "along.toKm": "Ende des Suchabschnitts in Kilometern ab dem Routenstart; der Abschnitt ist höchstens 200 km lang.",
      "along.bufferMeters": "Abstand zur Route von 100–5.000 Metern; ohne Angabe 1.000 Meter.",
      limit: "1–20 Ergebnisse; ohne Angabe 20.",
    },
  },
  "geo.availability": {
    title: "Geo-Verfügbarkeit prüfen",
    description: "Zeigt Einrichtung, persönliche und Cloud-Budgetgrenzen und deren Rücksetzzeit. Kostenlos, ohne Anbieteraufruf.",
  },
};
