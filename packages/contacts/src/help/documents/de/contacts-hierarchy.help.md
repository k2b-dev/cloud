---
id: contacts-hierarchy
title: Hierarchie
icon: ti ti-hierarchy
description: Einen Kontakt einem übergeordneten Kontakt zuordnen, Mitglieder hinzufügen, die Hierarchie öffnen und ihre Regeln beachten.
order: 110
---

Die Kontakthierarchie verknüpft Kontakte im selben Kontaktbuch, wenn ein Kontakt einem anderen zugeordnet ist.

## Kontakte verknüpfen {icon="route"}

:::reference
- **Gehört zu:** Ein optionales Feld im Kontakteditor für den übergeordneten Kontakt. Ist es gesetzt, wird der Kontakt ein Mitglied dieses Kontakts.
- **Mitglieder:** Ein übergeordneter Kontakt zeigt seine direkten Mitglieder im Detailbereich. Mit Zugriff **Bearbeiten** oder **Verwalten** auf das Kontaktbuch fügst du dort ein Mitglied hinzu.
- **Hierarchie:** Lädt den obersten übergeordneten Kontakt und alle untergeordneten Kontakte des ausgewählten Kontakts, unabhängig von der aktuellen Ergebnisseite.
- **Gleiches Kontaktbuch:** Übergeordnete Kontakte und ihre Mitglieder müssen im selben Kontaktbuch liegen. Verschiebst du einen Kontakt in ein anderes Kontaktbuch, entfallen die Verknüpfungen, die über Kontaktbuchgrenzen hinweg reichen würden.
:::

## Die Regeln beachten {icon="book-2"}

:::reference
- **Keine Zyklen:** Ein Kontakt kann nicht sein eigener übergeordneter Kontakt sein. Der Server lehnt auch kreisförmige Zuordnungen ab.
- **Nur die Verknüpfung:** Das Entfernen eines Mitglieds löst nur die Verknüpfung zum übergeordneten Kontakt. Der Kontakt selbst bleibt im Kontaktbuch.
- **Zugriff Ansehen:** Mit Zugriff **Ansehen** kannst du Kontakte sehen. Um Zuordnungen zu ändern, brauchst du Zugriff **Bearbeiten** oder **Verwalten** auf das Kontaktbuch.
:::

:::success Hierarchie sparsam einsetzen
Nutze die Hierarchie für dauerhafte Zugehörigkeit. Nutze Tags für lose Kategorien, die sich überschneiden dürfen.
:::
