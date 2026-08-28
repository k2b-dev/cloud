---
id: contacts-hierarchy
title: Hierarchie
icon: ti ti-hierarchy
description: Übergeordnete Kontakte, Mitglieder, Baumansicht und Regeln für Hierarchien.
order: 110
---

Die Kontakthierarchie verknüpft Kontakte im selben Kontaktbuch, wenn ein Kontakt einem anderen zugeordnet ist.

## So funktioniert die Hierarchie {icon="route"}

:::reference
- **Gehört zu:** Der Kontakteditor enthält ein optionales Feld für den übergeordneten Kontakt. Ist es gesetzt, erscheint der Kontakt als Mitglied dieses Kontakts.
- **Mitglieder:** Ein übergeordneter Kontakt zeigt seine direkten Mitglieder im Detailbereich. Dort kannst du ein Mitglied hinzufügen, wenn du das Kontaktbuch bearbeiten darfst.
- **Hierarchie:** Diese Ansicht lädt den obersten übergeordneten Kontakt und alle untergeordneten Kontakte des ausgewählten Kontakts, unabhängig von der aktuellen Ergebnisseite.
- **Gleiches Kontaktbuch:** Übergeordnete Kontakte und Mitglieder müssen im selben Kontaktbuch liegen. Beim Verschieben eines Kontakts werden Verknüpfungen entfernt, die Grenzen von Kontaktbüchern überschreiten würden.
:::

## Diese Regeln gelten {icon="book-2"}

:::reference
- **Keine Zyklen:** Ein Kontakt kann nicht sein eigener übergeordneter Kontakt sein. Kreisförmige Zuordnungen sind ebenfalls nicht möglich.
- **Nur die Verknüpfung:** Das Entfernen eines Mitglieds löst nur die Verknüpfung zum übergeordneten Kontakt. Der Kontakt selbst bleibt im Kontaktbuch.
- **Grenzen bei Lesezugriff:** Mit Lesezugriff kannst du Kontakte ansehen. Zuordnungen lassen sich nur in Kontaktbüchern ändern, die du bearbeiten darfst.
:::

:::success Hierarchie sparsam einsetzen
Nutze die Hierarchie für dauerhafte Zugehörigkeit. Nutze Tags für lose Kategorien, die sich überschneiden dürfen.
:::
