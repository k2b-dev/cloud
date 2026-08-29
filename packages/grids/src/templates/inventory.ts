import { i18n } from "@k2b/stdlib";
import { createMockCover } from "@valentinkolb/cloud/shared";
import { currentMonthDate, field, form, formula, type GridTemplate, launcher, record, table, view, viewColumns } from "./types";

const inventoryMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      templateName: "Inventory",
      templateDescription: "Track assets, storage locations, equipment loans, agreements, and repairs.",
      templateHighlightRecords: "Assets, kits, locations, and loan requests",
      templateHighlightOverview: "Availability and loan workload overview",
      templateHighlightWorkflows: "Guided agreement delivery, returns, and asset-label defect reporting",
      baseDescription: "Manage inventory, locations, kits, and loan requests.",
      categories: "Categories",
      name: "Name",
      categoryNameDescription: "Category name shown on items and kits.",
      description: "Description",
      categoryDescriptionDescription: "Optional notes that explain what belongs in this category.",
      locations: "Locations",
      locationNameDescription: "Location name shown in item records.",
      room: "Room",
      locationRoomDescription: "Room or area where this location sits.",
      shelf: "Shelf",
      locationShelfDescription: "Shelf, cabinet, or bin identifier.",
      notes: "Notes",
      locationNotesDescription: "Internal notes about this storage location.",
      items: "Items",
      assetId: "Asset ID",
      assetIdDescription: "Server-generated inventory number for this item.",
      assetBarcode: "Asset barcode",
      assetBarcodeDescription: "Scannable barcode for the asset ID.",
      itemNameDescription: "Item name shown in inventory lists and cards.",
      category: "Category",
      itemCategoryDescription: "Category this item belongs to.",
      location: "Location",
      itemLocationDescription: "Current storage location for this item.",
      status: "Status",
      itemStatusDescription: "Availability state used for filtering and loan planning.",
      available: "Available",
      reserved: "Reserved",
      inUse: "In use",
      maintenance: "Maintenance",
      condition: "Condition",
      itemConditionDescription: "Physical condition of this item.",
      new: "New",
      good: "Good",
      used: "Used",
      needsRepair: "Needs repair",
      serialNumber: "Serial number",
      serialNumberDescription: "Manufacturer serial number or other external identifier.",
      tags: "Tags",
      tagsDescription: "Reusable tags for item handling and search.",
      portable: "Portable",
      fragile: "Fragile",
      calibrated: "Calibrated",
      shared: "Shared",
      quantity: "Quantity",
      quantityDescription: "Number of units represented by this record.",
      replacementValue: "Replacement value",
      replacementValueDescription: "Estimated cost to replace one unit.",
      totalValue: "Total value",
      totalValueDescription: "Quantity multiplied by replacement value.",
      purchaseDate: "Purchase date",
      purchaseDateDescription: "Date this item was purchased or added.",
      files: "Files",
      filesDescription: "Photos, manuals, receipts, or other attachments.",
      itemNotesDescription: "Internal notes about this item.",
      kits: "Kits",
      kitCode: "Kit code",
      kitCodeDescription: "Short generated code for this kit.",
      kitNameDescription: "Kit name shown to staff and requesters.",
      kitCategoryDescription: "Category this kit belongs to.",
      kitItemsDescription: "Inventory items included in this kit.",
      kitStatusDescription: "Operational state of this kit.",
      incomplete: "Incomplete",
      internalOnly: "Internal only",
      retired: "Retired",
      requestable: "Requestable",
      requestableDescription: "Whether this kit can be requested through forms.",
      kitDescriptionDescription: "Public-facing explanation of what the kit contains.",
      adminNotes: "Admin notes",
      kitNotesDescription: "Internal staff notes about this kit.",
      loans: "Loans",
      loanNumber: "Loan number",
      loanNumberDescription: "Generated loan request number.",
      requesterName: "Requester name",
      requesterNameDescription: "Person requesting or borrowing the kit.",
      requesterEmail: "Requester email",
      requesterEmailDescription: "Email address for loan communication.",
      organization: "Organization",
      organizationDescription: "Optional team, department, or external organization.",
      loanKitsDescription: "Kits requested or borrowed in this loan.",
      loanedItems: "Loaned items",
      loanedItemsDescription: "Specific inventory records handed out under this loan.",
      requestedFrom: "Requested from",
      requestedFromDescription: "Requested start date for the loan.",
      dueDate: "Due date",
      dueDateDescription: "Expected return date for borrowed kits.",
      scheduleValid: "Schedule valid",
      scheduleValidDescription: "Whether the return date is on or after the requested start date.",
      returnedAt: "Returned at",
      returnedAtDescription: "Actual date when the kits were returned.",
      loanStatusDescription: "Current approval and return status.",
      requested: "Requested",
      approved: "Approved",
      active: "Active",
      returned: "Returned",
      rejected: "Rejected",
      cancelled: "Cancelled",
      availabilityConfirmed: "Availability confirmed",
      availabilityConfirmedDescription: "An admin has checked the selected kits, their items, and the requested dates before approval.",
      agreementSent: "Agreement sent",
      agreementSentDescription: "Set once the agreement workflow has succeeded, so it is not replayed.",
      purpose: "Purpose",
      purposeDescription: "Requester-provided reason for the loan.",
      loanNotesDescription: "Internal staff notes about this loan.",
      cameras: "Cameras",
      audio: "Audio",
      cables: "Cables",
      studioShelf: "Studio shelf",
      studio: "Studio",
      storageCabinet: "Storage cabinet",
      storage: "Storage",
      sonyA7Body: "Sony A7 body",
      wirelessMicSet: "Wireless mic set",
      hdmiCable: "HDMI cable 5m",
      videoInterviewKit: "Video interview kit",
      videoInterviewKitDescription: "Camera body, wireless mic set, and HDMI cable for interviews.",
      designTeam: "Design team",
      productInterviewPurpose: "Record a short product interview.",
      trainingTeam: "Training team",
      trainingRecordingPurpose: "Prepare a team training recording.",
      availableItems: "Available items",
      openLoans: "Open loans",
      addItem: "Add item",
      itemAdded: "Item added.",
      itemName: "Item name",
      itemNameHelp: "Name shown in inventory lists.",
      categoryHelp: "Pick an existing category or create one inline.",
      categoryName: "Category name",
      categoryNameHelp: "Short category name, for example Cameras.",
      locationHelp: "Where this item is stored.",
      locationName: "Location name",
      locationNameHelp: "Readable location label.",
      roomHelp: "Room or area.",
      shelfHelp: "Shelf, box, or cabinet.",
      statusHelp: "Current availability.",
      conditionHelp: "Physical state of the item.",
      tagsHelp: "Optional handling or usage labels.",
      quantityHelp: "How many units are available.",
      replacementValueHelp: "Cost to replace one unit.",
      notesHelp: "Extra context for admins.",
      requestLoan: "Request loan",
      requestKitLoan: "Request kit loan",
      requestKitLoanDescription: "Choose one or more kits. An admin reviews and approves the request.",
      loanRequested: "Loan requested.",
      requesterFormName: "Name",
      requesterNameHelp: "Who should receive the kit.",
      email: "Email",
      emailHelp: "Contact address for questions and approval.",
      organizationHelp: "Team, company, or project.",
      kitsHelp: "Choose one or more kits to borrow.",
      startDate: "Start date",
      startDateHelp: "First planned day of use.",
      dueDateHelp: "Planned return date.",
      purposeHelp: "What the kit will be used for.",
      equipmentLoans: "Equipment loans",
      newLoan: "New loan",
      myEquipmentLoans: "My equipment loans",
      equipmentLoansGuidance:
        "# Equipment loans\n\nUse **New loan** to request a kit. Open a loan to follow its approval, agreement, handover, and return.",
      myLoans: "My loans",
      noEquipmentLoans: "You do not have any equipment loans yet.",
      equipmentCatalog: "Equipment catalog",
      availableEquipment: "Available equipment",
      noAvailableEquipment: "No equipment is currently available.",
      loanDetails: "Loan details",
      loanOverview: "Loan overview",
      cancelRequest: "Cancel request",
      cancelRequestConfirm: "Cancel this loan request?",
      questionsAndUpdates: "Questions and updates",
      equipmentDetails: "Equipment details",
      loanDesk: "Loan desk",
      overdueLoans: "Overdue loans",
      operationalLoanQueue: "Operational loan queue",
      noOpenLoans: "No open loans.",
      inventoryValue: "Inventory value",
      loansByStatus: "Loans by status",
      returns: "Returns",
      reportDamagedItem: "Report damaged item",
      loanAdministration: "Loan administration",
      loanAndHandover: "Loan and handover",
      approveLoan: "Approve loan",
      approveLoanConfirm: "Approve this loan after checking availability?",
      sendAgreementAndStartLoan: "Send agreement and start loan",
      sendAgreementConfirm: "Send the agreement and mark the approved loan active?",
      loanNotesAndUpdates: "Loan notes and updates",
      assetLabel: "Asset label",
      assetLabelDescription: "Printable inventory label used to identify and scan one item.",
      loanAgreement: "Loan agreement",
      loanAgreementDescription: "Printable loan agreement for one inventory loan.",
      loanAgreementReady: "Loan agreement ready",
      loanAgreementReadyDescription: "Sends a private download link for a generated loan agreement.",
      loanAgreementSubject: "Loan agreement {{ data.loanNumber | default: 'ready' }}",
      loanAgreementEmail: `<main style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;max-width:640px;margin:0 auto;padding:32px;">
  <h1 style="font-size:24px;margin:0 0 16px;">Your loan agreement is ready</h1>
  <p>Hello {{ data.requesterName | default: "there" }},</p>
  <p>Your agreement{% if data.loanNumber %} for loan <strong>{{ data.loanNumber }}</strong>{% endif %} has been prepared.{% if data.dueDate %} The planned return date is <strong>{{ data.dueDate }}</strong>.{% endif %}</p>
  <p style="margin:24px 0;"><a href="{{ data.agreement.url }}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;">Download agreement</a></p>
  <p style="color:#6b7280;font-size:14px;">This private link expires automatically.</p>
</main>`,
      sampleDueDate: "31 July 2026",
      cancelRequestedLoan: "Cancel requested loan",
      cancelRequestedLoanDescription: "Lets the requester cancel only a loan that is still awaiting review.",
      workflowLoanLabel: "Loan",
      onlyRequestedLoanCanBeCancelled: "Only a requested loan can be cancelled.",
      loanCancelled: ({ loanNumber }: { loanNumber: string }) => `Loan ${loanNumber} cancelled.`,
      approveEquipmentLoan: "Approve equipment loan",
      approveEquipmentLoanDescription: "Approves one requested loan after dates and availability were checked.",
      onlyRequestedLoanCanBeApproved: "Only a requested loan can be approved.",
      dueDateMustFollowStartDate: "The due date must be on or after the requested start date.",
      confirmAvailabilityBeforeApproval: "Confirm kit, item, and date availability before approval.",
      loanApproved: ({ loanNumber }: { loanNumber: string }) => `Loan ${loanNumber} approved.`,
      sendApprovedLoanAgreement: "Send approved loan agreement",
      sendApprovedLoanAgreementDescription:
        "Generates and emails an agreement after an admin has approved the loan and confirmed availability.",
      approveBeforeSendingAgreement: "Approve this loan after checking availability before sending its agreement.",
      agreementAlreadySent: "This agreement was already sent. Open the generated documents to download or share it again.",
      confirmAvailabilityBeforeSending: "Confirm kit, item, and date availability before sending the agreement.",
      addRequesterEmail: "Add a requester email address before sending this agreement.",
      replaceSampleEmail: "Replace the sample requester email before sending a real agreement.",
      agreementSentMessage: ({ loanNumber }: { loanNumber: string }) => `Agreement for loan ${loanNumber} sent.`,
      reportDamagedItemDescription: "Moves a scanned inventory item into maintenance and marks it as needing repair.",
      inventoryItem: "Inventory item",
      itemAlreadyInMaintenance: ({ assetId }: { assetId: string }) => `Item ${assetId} is already in maintenance.`,
      itemMovedToMaintenance: ({ assetId, name }: { assetId: string; name: string }) => `Item ${assetId} · ${name} moved to maintenance.`,
      markLoanItemReturned: "Mark loan item as returned",
      markLoanItemReturnedDescription: "Uses one selected loan for the scanner session, then records the condition of every scanned item.",
      returnLoanDescription: "Select the active loan being returned.",
      returnedItem: "Returned item",
      returnedCondition: "Returned condition",
      returnedConditionDescription: "Assess this item after scanning it.",
      loanNotActive: ({ loanNumber }: { loanNumber: string }) => `Loan ${loanNumber} is not active.`,
      itemNotInLoan: ({ assetId, loanNumber }: { assetId: string; loanNumber: string }) =>
        `Item ${assetId} does not belong to loan ${loanNumber}.`,
      itemNotInUse: ({ assetId }: { assetId: string }) => `Item ${assetId} is not currently in use.`,
      itemReturnedForRepair: ({ assetId, loanNumber }: { assetId: string; loanNumber: string }) =>
        `Item ${assetId} returned for loan ${loanNumber} and moved to maintenance.`,
      itemReturnedWithCondition: ({ assetId, condition, loanNumber }: { assetId: string; condition: string; loanNumber: string }) =>
        `Item ${assetId} returned for loan ${loanNumber} in ${condition} condition.`,
      chooseLoanToSendAgreement: "Choose loan to send agreement",
      scanDamagedInventoryItem: "Scan damaged inventory item",
      returnItemsForLoan: "Return items for one loan",
    },
    de: {
      templateName: "Inventar",
      templateDescription: "Verwalte Gegenstände, Lagerorte, Ausleihen, Vereinbarungen und Reparaturen.",
      templateHighlightRecords: "Gegenstände, Sets, Lagerorte und Ausleihanfragen",
      templateHighlightOverview: "Überblick über Verfügbarkeit und offene Ausleihen",
      templateHighlightWorkflows: "Geführter Vereinbarungsversand, Rückgaben und Schadensmeldungen per Inventaretikett",
      baseDescription: "Verwalte Inventar, Lagerorte, Sets und Ausleihanfragen.",
      categories: "Kategorien",
      name: "Name",
      categoryNameDescription: "Kategoriename, der bei Gegenständen und Sets angezeigt wird.",
      description: "Beschreibung",
      categoryDescriptionDescription: "Optionale Hinweise dazu, was zu dieser Kategorie gehört.",
      locations: "Lagerorte",
      locationNameDescription: "Name des Lagerorts, der in Gegenstandsdatensätzen angezeigt wird.",
      room: "Raum",
      locationRoomDescription: "Raum oder Bereich, in dem sich dieser Lagerort befindet.",
      shelf: "Regal",
      locationShelfDescription: "Kennung für Regal, Schrank oder Behälter.",
      notes: "Notizen",
      locationNotesDescription: "Interne Notizen zu diesem Lagerort.",
      items: "Gegenstände",
      assetId: "Inventar-ID",
      assetIdDescription: "Vom Server erzeugte Inventarnummer für diesen Gegenstand.",
      assetBarcode: "Inventar-Barcode",
      assetBarcodeDescription: "Scanbarer Barcode für die Inventar-ID.",
      itemNameDescription: "Gegenstandsname, der in Inventarlisten und Karten angezeigt wird.",
      category: "Kategorie",
      itemCategoryDescription: "Kategorie, zu der dieser Gegenstand gehört.",
      location: "Lagerort",
      itemLocationDescription: "Aktueller Lagerort dieses Gegenstands.",
      status: "Status",
      itemStatusDescription: "Verfügbarkeitsstatus für Filter und Ausleihplanung.",
      available: "Verfügbar",
      reserved: "Reserviert",
      inUse: "In Verwendung",
      maintenance: "Wartung",
      condition: "Zustand",
      itemConditionDescription: "Physischer Zustand dieses Gegenstands.",
      new: "Neu",
      good: "Gut",
      used: "Gebraucht",
      needsRepair: "Reparatur erforderlich",
      serialNumber: "Seriennummer",
      serialNumberDescription: "Seriennummer des Herstellers oder andere externe Kennung.",
      tags: "Schlagwörter",
      tagsDescription: "Wiederverwendbare Schlagwörter für Handhabung und Suche.",
      portable: "Tragbar",
      fragile: "Zerbrechlich",
      calibrated: "Kalibriert",
      shared: "Gemeinsam genutzt",
      quantity: "Anzahl",
      quantityDescription: "Anzahl der Einheiten, die dieser Datensatz darstellt.",
      replacementValue: "Wiederbeschaffungswert",
      replacementValueDescription: "Geschätzte Kosten für den Ersatz einer Einheit.",
      totalValue: "Gesamtwert",
      totalValueDescription: "Anzahl multipliziert mit dem Wiederbeschaffungswert.",
      purchaseDate: "Kaufdatum",
      purchaseDateDescription: "Datum, an dem dieser Gegenstand gekauft oder hinzugefügt wurde.",
      files: "Dateien",
      filesDescription: "Fotos, Anleitungen, Belege oder andere Anhänge.",
      itemNotesDescription: "Interne Notizen zu diesem Gegenstand.",
      kits: "Sets",
      kitCode: "Set-Kennung",
      kitCodeDescription: "Kurze erzeugte Kennung für dieses Set.",
      kitNameDescription: "Set-Name, der Mitarbeitenden und anfragenden Personen angezeigt wird.",
      kitCategoryDescription: "Kategorie, zu der dieses Set gehört.",
      kitItemsDescription: "Inventargegenstände in diesem Set.",
      kitStatusDescription: "Betriebsstatus dieses Sets.",
      incomplete: "Unvollständig",
      internalOnly: "Nur intern",
      retired: "Ausgemustert",
      requestable: "Ausleihbar",
      requestableDescription: "Gibt an, ob dieses Set über Formulare angefragt werden kann.",
      kitDescriptionDescription: "Öffentliche Beschreibung des Set-Inhalts.",
      adminNotes: "Admin-Notizen",
      kitNotesDescription: "Interne Notizen von Mitarbeitenden zu diesem Set.",
      loans: "Ausleihen",
      loanNumber: "Ausleihnummer",
      loanNumberDescription: "Erzeugte Nummer der Ausleihanfrage.",
      requesterName: "Name der anfragenden Person",
      requesterNameDescription: "Person, die das Set anfragt oder ausleiht.",
      requesterEmail: "E-Mail der anfragenden Person",
      requesterEmailDescription: "E-Mail-Adresse für die Kommunikation zur Ausleihe.",
      organization: "Organisation",
      organizationDescription: "Optionales Team, Abteilung oder externe Organisation.",
      loanKitsDescription: "Sets, die mit dieser Ausleihe angefragt oder ausgeliehen werden.",
      loanedItems: "Ausgeliehene Gegenstände",
      loanedItemsDescription: "Konkrete Inventardatensätze, die für diese Ausleihe ausgegeben wurden.",
      requestedFrom: "Angefragt ab",
      requestedFromDescription: "Gewünschtes Startdatum der Ausleihe.",
      dueDate: "Rückgabedatum",
      dueDateDescription: "Erwartetes Rückgabedatum der ausgeliehenen Sets.",
      scheduleValid: "Zeitraum gültig",
      scheduleValidDescription: "Gibt an, ob das Rückgabedatum am oder nach dem gewünschten Startdatum liegt.",
      returnedAt: "Zurückgegeben am",
      returnedAtDescription: "Tatsächliches Datum der Rückgabe.",
      loanStatusDescription: "Aktueller Freigabe- und Rückgabestatus.",
      requested: "Angefragt",
      approved: "Freigegeben",
      active: "Aktiv",
      returned: "Zurückgegeben",
      rejected: "Abgelehnt",
      cancelled: "Storniert",
      availabilityConfirmed: "Verfügbarkeit bestätigt",
      availabilityConfirmedDescription:
        "Eine Person mit Admin-Rechten hat die ausgewählten Sets, deren Gegenstände und den angefragten Zeitraum vor der Freigabe geprüft.",
      agreementSent: "Vereinbarung gesendet",
      agreementSentDescription:
        "Wird gesetzt, nachdem der Workflow für die Vereinbarung erfolgreich war, damit er nicht erneut ausgeführt wird.",
      purpose: "Verwendungszweck",
      purposeDescription: "Von der anfragenden Person angegebener Grund für die Ausleihe.",
      loanNotesDescription: "Interne Notizen von Mitarbeitenden zu dieser Ausleihe.",
      cameras: "Kameras",
      audio: "Audio",
      cables: "Kabel",
      studioShelf: "Studioregal",
      studio: "Studio",
      storageCabinet: "Lagerschrank",
      storage: "Lager",
      sonyA7Body: "Sony-A7-Gehäuse",
      wirelessMicSet: "Funkmikrofon-Set",
      hdmiCable: "HDMI-Kabel, 5 m",
      videoInterviewKit: "Video-Interview-Set",
      videoInterviewKitDescription: "Kameragehäuse, Funkmikrofon-Set und HDMI-Kabel für Interviews.",
      designTeam: "Designteam",
      productInterviewPurpose: "Ein kurzes Produktinterview aufnehmen.",
      trainingTeam: "Schulungsteam",
      trainingRecordingPurpose: "Eine Schulungsaufnahme für das Team vorbereiten.",
      availableItems: "Verfügbare Gegenstände",
      openLoans: "Offene Ausleihen",
      addItem: "Gegenstand hinzufügen",
      itemAdded: "Gegenstand hinzugefügt.",
      itemName: "Gegenstandsname",
      itemNameHelp: "Name, der in Inventarlisten angezeigt wird.",
      categoryHelp: "Wähle eine vorhandene Kategorie oder erstelle direkt eine neue.",
      categoryName: "Kategoriename",
      categoryNameHelp: "Kurzer Kategoriename, zum Beispiel Kameras.",
      locationHelp: "Lagerort dieses Gegenstands.",
      locationName: "Name des Lagerorts",
      locationNameHelp: "Verständliche Bezeichnung des Lagerorts.",
      roomHelp: "Raum oder Bereich.",
      shelfHelp: "Regal, Kiste oder Schrank.",
      statusHelp: "Aktuelle Verfügbarkeit.",
      conditionHelp: "Physischer Zustand des Gegenstands.",
      tagsHelp: "Optionale Schlagwörter für Handhabung oder Verwendung.",
      quantityHelp: "Anzahl der verfügbaren Einheiten.",
      replacementValueHelp: "Kosten für den Ersatz einer Einheit.",
      notesHelp: "Zusätzlicher Kontext für Personen mit Admin-Rechten.",
      requestLoan: "Ausleihe anfragen",
      requestKitLoan: "Set-Ausleihe anfragen",
      requestKitLoanDescription: "Wähle ein oder mehrere Sets. Eine Person mit Admin-Rechten prüft die Anfrage und gibt sie frei.",
      loanRequested: "Ausleihe angefragt.",
      requesterFormName: "Name",
      requesterNameHelp: "Person, die das Set erhalten soll.",
      email: "E-Mail",
      emailHelp: "Kontaktadresse für Rückfragen und die Freigabe.",
      organizationHelp: "Team, Unternehmen oder Projekt.",
      kitsHelp: "Wähle ein oder mehrere Sets zum Ausleihen.",
      startDate: "Startdatum",
      startDateHelp: "Erster geplanter Nutzungstag.",
      dueDateHelp: "Geplantes Rückgabedatum.",
      purposeHelp: "Geplanter Verwendungszweck des Sets.",
      equipmentLoans: "Geräteausleihen",
      newLoan: "Neue Ausleihe",
      myEquipmentLoans: "Meine Geräteausleihen",
      equipmentLoansGuidance:
        "# Geräteausleihen\n\nFordere mit **Neue Ausleihe** ein Set an. Öffne eine Ausleihe, um Freigabe, Vereinbarung, Übergabe und Rückgabe zu verfolgen.",
      myLoans: "Meine Ausleihen",
      noEquipmentLoans: "Du hast noch keine Geräteausleihen.",
      equipmentCatalog: "Gerätekatalog",
      availableEquipment: "Verfügbare Geräte",
      noAvailableEquipment: "Derzeit sind keine Geräte verfügbar.",
      loanDetails: "Ausleihdetails",
      loanOverview: "Überblick zur Ausleihe",
      cancelRequest: "Anfrage stornieren",
      cancelRequestConfirm: "Diese Ausleihanfrage stornieren?",
      questionsAndUpdates: "Fragen und Neuigkeiten",
      equipmentDetails: "Gerätedetails",
      loanDesk: "Ausleihverwaltung",
      overdueLoans: "Überfällige Ausleihen",
      operationalLoanQueue: "Offene Ausleihvorgänge",
      noOpenLoans: "Keine offenen Ausleihen.",
      inventoryValue: "Inventarwert",
      loansByStatus: "Ausleihen nach Status",
      returns: "Rückgaben",
      reportDamagedItem: "Beschädigten Gegenstand melden",
      loanAdministration: "Ausleihe verwalten",
      loanAndHandover: "Ausleihe und Übergabe",
      approveLoan: "Ausleihe freigeben",
      approveLoanConfirm: "Diese Ausleihe nach der Verfügbarkeitsprüfung freigeben?",
      sendAgreementAndStartLoan: "Vereinbarung senden und Ausleihe starten",
      sendAgreementConfirm: "Die Vereinbarung senden und die freigegebene Ausleihe als aktiv markieren?",
      loanNotesAndUpdates: "Notizen und Neuigkeiten zur Ausleihe",
      assetLabel: "Inventaretikett",
      assetLabelDescription: "Druckbares Inventaretikett zum Identifizieren und Scannen eines Gegenstands.",
      loanAgreement: "Ausleihvereinbarung",
      loanAgreementDescription: "Druckbare Vereinbarung für eine Inventarausleihe.",
      loanAgreementReady: "Ausleihvereinbarung verfügbar",
      loanAgreementReadyDescription: "Sendet einen privaten Download-Link für eine erzeugte Ausleihvereinbarung.",
      loanAgreementSubject: "Ausleihvereinbarung {{ data.loanNumber | default: 'verfügbar' }}",
      loanAgreementEmail: `<main style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;max-width:640px;margin:0 auto;padding:32px;">
  <h1 style="font-size:24px;margin:0 0 16px;">Deine Ausleihvereinbarung ist verfügbar</h1>
  <p>Hallo{% if data.requesterName %} {{ data.requesterName }}{% endif %},</p>
  <p>Deine Vereinbarung{% if data.loanNumber %} für die Ausleihe <strong>{{ data.loanNumber }}</strong>{% endif %} wurde erstellt.{% if data.dueDate %} Das geplante Rückgabedatum ist der <strong>{{ data.dueDate }}</strong>.{% endif %}</p>
  <p style="margin:24px 0;"><a href="{{ data.agreement.url }}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;">Vereinbarung herunterladen</a></p>
  <p style="color:#6b7280;font-size:14px;">Dieser private Link läuft automatisch ab.</p>
</main>`,
      sampleDueDate: "31. Juli 2026",
      cancelRequestedLoan: "Angefragte Ausleihe stornieren",
      cancelRequestedLoanDescription: "Erlaubt der anfragenden Person, eine Ausleihe nur vor der Prüfung zu stornieren.",
      workflowLoanLabel: "Ausleihe",
      onlyRequestedLoanCanBeCancelled: "Nur eine angefragte Ausleihe kann storniert werden.",
      loanCancelled: ({ loanNumber }) => `Ausleihe ${loanNumber} storniert.`,
      approveEquipmentLoan: "Geräteausleihe freigeben",
      approveEquipmentLoanDescription: "Gibt eine angefragte Ausleihe frei, nachdem Zeitraum und Verfügbarkeit geprüft wurden.",
      onlyRequestedLoanCanBeApproved: "Nur eine angefragte Ausleihe kann freigegeben werden.",
      dueDateMustFollowStartDate: "Das Rückgabedatum muss am oder nach dem gewünschten Startdatum liegen.",
      confirmAvailabilityBeforeApproval: "Bestätige vor der Freigabe die Verfügbarkeit von Set, Gegenständen und Zeitraum.",
      loanApproved: ({ loanNumber }) => `Ausleihe ${loanNumber} freigegeben.`,
      sendApprovedLoanAgreement: "Vereinbarung für freigegebene Ausleihe senden",
      sendApprovedLoanAgreementDescription:
        "Erzeugt und sendet eine Vereinbarung per E-Mail, nachdem die Ausleihe freigegeben und die Verfügbarkeit bestätigt wurde.",
      approveBeforeSendingAgreement: "Gib diese Ausleihe nach der Verfügbarkeitsprüfung frei, bevor du die Vereinbarung sendest.",
      agreementAlreadySent:
        "Diese Vereinbarung wurde bereits gesendet. Öffne die erzeugten Dokumente, um sie erneut herunterzuladen oder zu teilen.",
      confirmAvailabilityBeforeSending: "Bestätige vor dem Versand der Vereinbarung die Verfügbarkeit von Set, Gegenständen und Zeitraum.",
      addRequesterEmail: "Füge vor dem Versand der Vereinbarung eine E-Mail-Adresse für die anfragende Person hinzu.",
      replaceSampleEmail: "Ersetze vor dem Versand einer echten Vereinbarung die Beispiel-E-Mail-Adresse.",
      agreementSentMessage: ({ loanNumber }) => `Vereinbarung für Ausleihe ${loanNumber} gesendet.`,
      reportDamagedItemDescription:
        "Verschiebt einen gescannten Inventargegenstand in die Wartung und markiert ihn als reparaturbedürftig.",
      inventoryItem: "Inventargegenstand",
      itemAlreadyInMaintenance: ({ assetId }) => `Gegenstand ${assetId} befindet sich bereits in Wartung.`,
      itemMovedToMaintenance: ({ assetId, name }) => `Gegenstand ${assetId} · ${name} wurde in die Wartung verschoben.`,
      markLoanItemReturned: "Ausgeliehenen Gegenstand zurückgeben",
      markLoanItemReturnedDescription:
        "Verwendet eine ausgewählte Ausleihe für die Scanner-Sitzung und erfasst anschließend den Zustand jedes gescannten Gegenstands.",
      returnLoanDescription: "Wähle die aktive Ausleihe aus, die zurückgegeben wird.",
      returnedItem: "Zurückgegebener Gegenstand",
      returnedCondition: "Zustand bei Rückgabe",
      returnedConditionDescription: "Bewerte den Gegenstand nach dem Scannen.",
      loanNotActive: ({ loanNumber }) => `Ausleihe ${loanNumber} ist nicht aktiv.`,
      itemNotInLoan: ({ assetId, loanNumber }) => `Gegenstand ${assetId} gehört nicht zur Ausleihe ${loanNumber}.`,
      itemNotInUse: ({ assetId }) => `Gegenstand ${assetId} wird derzeit nicht verwendet.`,
      itemReturnedForRepair: ({ assetId, loanNumber }) =>
        `Gegenstand ${assetId} wurde für Ausleihe ${loanNumber} zurückgegeben und in die Wartung verschoben.`,
      itemReturnedWithCondition: ({ assetId, condition, loanNumber }) =>
        `Gegenstand ${assetId} wurde für Ausleihe ${loanNumber} im Zustand ${condition} zurückgegeben.`,
      chooseLoanToSendAgreement: "Ausleihe für den Versand der Vereinbarung wählen",
      scanDamagedInventoryItem: "Beschädigten Inventargegenstand scannen",
      returnItemsForLoan: "Gegenstände einer Ausleihe zurückgeben",
    },
  },
});

export const createInventoryTemplate = (locale?: string): GridTemplate => {
  const { t } = inventoryMessages.resolve(locale ? [locale] : undefined);
  const workflowRefs = {
    assetId: `\${{ inputs.item.${t.assetId} }}`,
    condition: "${{ inputs.condition }}",
    itemName: `\${{ inputs.item.${t.name} }}`,
    loanNumber: `\${{ inputs.loan.${t.loanNumber} }}`,
  };

  return {
    id: "inventory",
    name: t.templateName,
    description: t.templateDescription,
    highlights: [t.templateHighlightRecords, t.templateHighlightOverview, t.templateHighlightWorkflows],
    icon: "ti ti-packages",
    baseName: t.templateName,
    baseDescription: t.baseDescription,
    tables: [
      {
        key: "categories",
        name: t.categories,
        fields: [
          {
            key: "name",
            name: t.name,
            description: t.categoryNameDescription,
            type: "text",
            required: true,
            presentable: true,
            icon: "ti ti-tag",
          },
          {
            key: "description",
            name: t.description,
            description: t.categoryDescriptionDescription,
            type: "longtext",
            config: { markdown: true },
            icon: "ti ti-align-left",
          },
        ],
      },
      {
        key: "locations",
        name: t.locations,
        fields: [
          {
            key: "name",
            name: t.name,
            description: t.locationNameDescription,
            type: "text",
            required: true,
            presentable: true,
            icon: "ti ti-map-pin",
          },
          {
            key: "room",
            name: t.room,
            description: t.locationRoomDescription,
            type: "text",
            icon: "ti ti-door",
          },
          {
            key: "shelf",
            name: t.shelf,
            description: t.locationShelfDescription,
            type: "text",
            icon: "ti ti-stack",
          },
          {
            key: "notes",
            name: t.notes,
            description: t.locationNotesDescription,
            type: "longtext",
            config: { markdown: true },
            icon: "ti ti-notes",
          },
        ],
      },
      {
        key: "items",
        name: t.items,
        displayConfig: {
          mode: "cards",
          cards: {
            imageFieldId: field("items.files"),
            fieldIds: [
              field("items.asset_id"),
              field("items.asset_barcode"),
              field("items.name"),
              field("items.category"),
              field("items.location"),
              field("items.status"),
              field("items.condition"),
              field("items.quantity"),
            ],
          },
        },
        fields: [
          {
            key: "asset_id",
            name: t.assetId,
            description: t.assetIdDescription,
            type: "id",
            config: { strategy: "sequence", prefix: "ITEM-", padding: 4 },
            presentable: true,
            icon: "ti ti-id",
          },
          {
            key: "asset_barcode",
            name: t.assetBarcode,
            description: t.assetBarcodeDescription,
            type: "formula",
            config: {
              expression: formula(field("items.asset_id")),
              format: { kind: "barcode", bcid: "code128", showText: true },
            },
            icon: "ti ti-barcode",
          },
          {
            key: "name",
            name: t.name,
            description: t.itemNameDescription,
            type: "text",
            required: true,
            presentable: true,
            icon: "ti ti-package",
          },
          {
            key: "category",
            name: t.category,
            description: t.itemCategoryDescription,
            type: "relation",
            icon: "ti ti-tag",
            config: { targetTableId: table("categories"), cardinality: "single" },
          },
          {
            key: "location",
            name: t.location,
            description: t.itemLocationDescription,
            type: "relation",
            icon: "ti ti-map-pin",
            config: { targetTableId: table("locations"), cardinality: "single" },
          },
          {
            key: "status",
            name: t.status,
            description: t.itemStatusDescription,
            type: "select",
            icon: "ti ti-traffic-lights",
            config: {
              options: [
                { id: "available", label: t.available, color: "#22c55e" },
                { id: "reserved", label: t.reserved, color: "#3b82f6" },
                { id: "in_use", label: t.inUse, color: "#f59e0b" },
                { id: "maintenance", label: t.maintenance, color: "#ef4444" },
              ],
            },
            required: true,
            defaultValue: ["available"],
          },
          {
            key: "condition",
            name: t.condition,
            description: t.itemConditionDescription,
            type: "select",
            icon: "ti ti-stars",
            config: {
              options: [
                { id: "new", label: t.new, color: "#22c55e" },
                { id: "good", label: t.good, color: "#3b82f6" },
                { id: "used", label: t.used, color: "#f59e0b" },
                { id: "repair", label: t.needsRepair, color: "#ef4444" },
              ],
            },
          },
          {
            key: "serial_no",
            name: t.serialNumber,
            description: t.serialNumberDescription,
            type: "text",
            icon: "ti ti-barcode",
          },
          {
            key: "tags",
            name: t.tags,
            description: t.tagsDescription,
            type: "select",
            icon: "ti ti-tags",
            config: {
              multiple: true,
              options: [
                { id: "portable", label: t.portable, color: "#3b82f6" },
                { id: "fragile", label: t.fragile, color: "#f59e0b" },
                { id: "calibrated", label: t.calibrated, color: "#22c55e" },
                { id: "shared", label: t.shared, color: "#8b5cf6" },
              ],
            },
          },
          {
            key: "quantity",
            name: t.quantity,
            description: t.quantityDescription,
            type: "number",
            required: true,
            defaultValue: "1",
            config: { min: "0", decimalPlaces: 0 },
            icon: "ti ti-hash",
          },
          {
            key: "replacement_value",
            name: t.replacementValue,
            description: t.replacementValueDescription,
            type: "number",
            icon: "ti ti-currency-euro",
            config: {
              precision: 16,
              decimalPlaces: 2,
              unit: "EUR",
              unitPosition: "suffix",
            },
          },
          {
            key: "total_value",
            name: t.totalValue,
            description: t.totalValueDescription,
            type: "formula",
            config: {
              expression: formula(field("items.quantity"), " * ", field("items.replacement_value")),
              format: {
                kind: "decimal",
                precision: 2,
                thousandsSeparator: true,
              },
            },
            icon: "ti ti-calculator",
          },
          {
            key: "purchase_date",
            name: t.purchaseDate,
            description: t.purchaseDateDescription,
            type: "date",
            icon: "ti ti-calendar",
          },
          {
            key: "files",
            name: t.files,
            description: t.filesDescription,
            type: "file",
            icon: "ti ti-paperclip",
            config: { maxFiles: 5 },
          },
          {
            key: "notes",
            name: t.notes,
            description: t.itemNotesDescription,
            type: "longtext",
            config: { markdown: true },
            icon: "ti ti-notes",
          },
        ],
      },
      {
        key: "kits",
        name: t.kits,
        fields: [
          {
            key: "kit_code",
            name: t.kitCode,
            description: t.kitCodeDescription,
            type: "id",
            config: { strategy: "short_code", prefix: "KIT-", length: 6 },
            presentable: true,
            icon: "ti ti-id",
          },
          {
            key: "name",
            name: t.name,
            description: t.kitNameDescription,
            type: "text",
            required: true,
            presentable: true,
            icon: "ti ti-tag",
          },
          {
            key: "category",
            name: t.category,
            description: t.kitCategoryDescription,
            type: "relation",
            icon: "ti ti-tag",
            config: { targetTableId: table("categories"), cardinality: "single" },
          },
          {
            key: "items",
            name: t.items,
            description: t.kitItemsDescription,
            type: "relation",
            icon: "ti ti-package",
            config: { targetTableId: table("items"), cardinality: "multiple" },
          },
          {
            key: "status",
            name: t.status,
            description: t.kitStatusDescription,
            type: "select",
            icon: "ti ti-circle-check",
            config: {
              options: [
                { id: "available", label: t.available, color: "#22c55e" },
                { id: "reserved", label: t.reserved, color: "#3b82f6" },
                { id: "incomplete", label: t.incomplete, color: "#f59e0b" },
                { id: "internal", label: t.internalOnly, color: "#3b82f6" },
                { id: "retired", label: t.retired, color: "#94a3b8" },
              ],
            },
            required: true,
            defaultValue: ["available"],
          },
          {
            key: "requestable",
            name: t.requestable,
            description: t.requestableDescription,
            type: "boolean",
            defaultValue: true,
            icon: "ti ti-world-check",
          },
          {
            key: "description",
            name: t.description,
            description: t.kitDescriptionDescription,
            type: "longtext",
            config: { markdown: true },
            icon: "ti ti-align-left",
          },
          {
            key: "notes",
            name: t.adminNotes,
            description: t.kitNotesDescription,
            type: "longtext",
            config: { markdown: true },
            icon: "ti ti-notes",
          },
        ],
      },
      {
        key: "loans",
        name: t.loans,
        fields: [
          {
            key: "loan_no",
            name: t.loanNumber,
            description: t.loanNumberDescription,
            type: "id",
            config: {
              strategy: "date_sequence",
              prefix: "LOAN-",
              period: "year",
              padding: 4,
            },
            presentable: true,
            icon: "ti ti-id",
          },
          {
            key: "requester_name",
            name: t.requesterName,
            description: t.requesterNameDescription,
            type: "text",
            required: true,
            presentable: true,
            icon: "ti ti-user",
          },
          {
            key: "requester_email",
            name: t.requesterEmail,
            description: t.requesterEmailDescription,
            type: "text",
            config: { regex: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" },
            required: true,
            icon: "ti ti-mail",
          },
          {
            key: "organization",
            name: t.organization,
            description: t.organizationDescription,
            type: "text",
            icon: "ti ti-building",
          },
          {
            key: "kits",
            name: t.kits,
            description: t.loanKitsDescription,
            type: "relation",
            required: true,
            icon: "ti ti-box",
            config: { targetTableId: table("kits"), cardinality: "multiple" },
          },
          {
            key: "items",
            name: t.loanedItems,
            description: t.loanedItemsDescription,
            type: "relation",
            icon: "ti ti-package",
            config: { targetTableId: table("items"), cardinality: "multiple" },
          },
          {
            key: "start_date",
            name: t.requestedFrom,
            description: t.requestedFromDescription,
            type: "date",
            required: true,
            icon: "ti ti-calendar-plus",
          },
          {
            key: "due_date",
            name: t.dueDate,
            description: t.dueDateDescription,
            type: "date",
            required: true,
            icon: "ti ti-calendar-due",
          },
          {
            key: "schedule_valid",
            name: t.scheduleValid,
            description: t.scheduleValidDescription,
            type: "formula",
            config: {
              expression: formula(field("loans.start_date"), " <= ", field("loans.due_date")),
            },
            icon: "ti ti-calendar-check",
          },
          {
            key: "returned_at",
            name: t.returnedAt,
            description: t.returnedAtDescription,
            type: "date",
            icon: "ti ti-calendar-check",
          },
          {
            key: "status",
            name: t.status,
            description: t.loanStatusDescription,
            type: "select",
            icon: "ti ti-progress",
            config: {
              options: [
                { id: "requested", label: t.requested, color: "#3b82f6" },
                { id: "approved", label: t.approved, color: "#22c55e" },
                { id: "active", label: t.active, color: "#f59e0b" },
                { id: "returned", label: t.returned, color: "#94a3b8" },
                { id: "rejected", label: t.rejected, color: "#ef4444" },
                { id: "cancelled", label: t.cancelled, color: "#94a3b8" },
              ],
            },
            required: true,
            defaultValue: ["requested"],
          },
          {
            key: "availability_confirmed",
            name: t.availabilityConfirmed,
            description: t.availabilityConfirmedDescription,
            type: "boolean",
            defaultValue: false,
            icon: "ti ti-calendar-check",
          },
          {
            key: "agreement_sent",
            name: t.agreementSent,
            description: t.agreementSentDescription,
            type: "boolean",
            defaultValue: false,
            icon: "ti ti-mail-check",
          },
          {
            key: "purpose",
            name: t.purpose,
            description: t.purposeDescription,
            type: "longtext",
            icon: "ti ti-message",
          },
          {
            key: "notes",
            name: t.adminNotes,
            description: t.loanNotesDescription,
            type: "longtext",
            config: { markdown: true },
            icon: "ti ti-notes",
          },
        ],
      },
    ],
    records: [
      {
        key: "categories.cameras",
        table: "categories",
        values: { name: t.cameras },
      },
      { key: "categories.audio", table: "categories", values: { name: t.audio } },
      {
        key: "categories.cables",
        table: "categories",
        values: { name: t.cables },
      },
      {
        key: "locations.studio",
        table: "locations",
        values: { name: t.studioShelf, room: t.studio, shelf: "A2" },
      },
      {
        key: "locations.storage",
        table: "locations",
        values: { name: t.storageCabinet, room: t.storage, shelf: "C1" },
      },
      {
        key: "items.camera",
        table: "items",
        values: {
          name: t.sonyA7Body,
          category: [record("categories.cameras")],
          location: [record("locations.studio")],
          status: ["in_use"],
          condition: ["good"],
          serial_no: "A7-001",
          tags: ["fragile", "portable"],
          quantity: "1",
          replacement_value: "1800.00",
          purchase_date: "2025-09-12",
        },
        files: [
          {
            field: "files",
            filename: "sony-a7-body.svg",
            dataUrl: createMockCover({
              icon: "camera",
              theme: "blue",
              seed: "inventory:sony-a7-body",
              label: t.sonyA7Body,
            }).dataUrl,
          },
        ],
      },
      {
        key: "items.mic",
        table: "items",
        values: {
          name: t.wirelessMicSet,
          category: [record("categories.audio")],
          location: [record("locations.studio")],
          status: ["available"],
          condition: ["good"],
          tags: ["portable", "shared"],
          quantity: "2",
          replacement_value: "320.00",
        },
        files: [
          {
            field: "files",
            filename: "wireless-mic-set.svg",
            dataUrl: createMockCover({
              icon: "microphone",
              theme: "violet",
              seed: "inventory:wireless-mic-set",
              label: t.wirelessMicSet,
            }).dataUrl,
          },
        ],
      },
      {
        key: "items.hdmi",
        table: "items",
        values: {
          name: t.hdmiCable,
          category: [record("categories.cables")],
          location: [record("locations.storage")],
          status: ["available"],
          condition: ["used"],
          tags: ["shared"],
          quantity: "8",
          replacement_value: "18.00",
        },
        files: [
          {
            field: "files",
            filename: "hdmi-cable-5m.svg",
            dataUrl: createMockCover({
              icon: "package",
              theme: "slate",
              seed: "inventory:hdmi-cable-5m",
              label: t.hdmiCable,
            }).dataUrl,
          },
        ],
      },
      {
        key: "kits.video",
        table: "kits",
        values: {
          name: t.videoInterviewKit,
          category: [record("categories.cameras")],
          items: [record("items.camera"), record("items.mic"), record("items.hdmi")],
          status: ["available"],
          requestable: true,
          description: t.videoInterviewKitDescription,
        },
      },
      {
        key: "loans.demo",
        table: "loans",
        values: {
          requester_name: "Mara Example",
          requester_email: "mara@example.test",
          organization: t.designTeam,
          kits: [record("kits.video")],
          items: [record("items.camera")],
          start_date: currentMonthDate(10),
          due_date: currentMonthDate(12),
          status: ["active"],
          availability_confirmed: true,
          agreement_sent: false,
          purpose: t.productInterviewPurpose,
        },
      },
      {
        key: "loans.demo_2",
        table: "loans",
        values: {
          requester_name: "Jonas Example",
          requester_email: "jonas@example.test",
          organization: t.trainingTeam,
          kits: [record("kits.video")],
          start_date: currentMonthDate(18),
          due_date: currentMonthDate(20),
          status: ["rejected"],
          availability_confirmed: false,
          agreement_sent: false,
          purpose: t.trainingRecordingPurpose,
        },
      },
    ],
    views: [
      {
        key: "available_items",
        table: "items",
        name: t.availableItems,
        shared: true,
        source: formula(
          "from table ",
          table("items"),
          "\nselect ",
          field("items.asset_barcode"),
          ", ",
          field("items.name"),
          ", ",
          field("items.category"),
          ", ",
          field("items.location"),
          ", ",
          field("items.quantity"),
          ", ",
          field("items.total_value"),
          "\nwhere ",
          field("items.status"),
          " = 'available'",
        ),
        ui: {
          columns: [
            {
              fieldId: field("items.asset_barcode"),
              label: t.assetId,
              format: { kind: "barcode", bcid: "code128", showText: true },
            },
            { fieldId: field("items.name") },
            { fieldId: field("items.category") },
            { fieldId: field("items.location") },
            { fieldId: field("items.quantity") },
            { fieldId: field("items.total_value") },
          ],
          displayConfig: {
            mode: "cards",
            cards: {
              imageFieldId: field("items.files"),
              fieldIds: [
                field("items.asset_id"),
                field("items.asset_barcode"),
                field("items.name"),
                field("items.category"),
                field("items.location"),
                field("items.status"),
                field("items.quantity"),
              ],
            },
          },
        },
      },
      {
        key: "open_loans",
        table: "loans",
        name: t.openLoans,
        shared: true,
        source: formula(
          "from table ",
          table("loans"),
          "\nselect ",
          field("loans.loan_no"),
          ", ",
          field("loans.requester_name"),
          ", ",
          field("loans.organization"),
          ", ",
          field("loans.kits"),
          ", ",
          field("loans.start_date"),
          ", ",
          field("loans.due_date"),
          ", ",
          field("loans.schedule_valid"),
          ", ",
          field("loans.status"),
          "\nwhere oneof(",
          field("loans.status"),
          ", 'requested', 'approved', 'active')\nsort ",
          field("loans.due_date"),
          " asc",
        ),
        ui: {
          columns: [
            { fieldId: field("loans.loan_no") },
            { fieldId: field("loans.requester_name") },
            { fieldId: field("loans.organization") },
            { fieldId: field("loans.kits") },
            { fieldId: field("loans.start_date") },
            { fieldId: field("loans.due_date") },
            { fieldId: field("loans.schedule_valid") },
            { fieldId: field("loans.status") },
          ],
          displayConfig: {
            mode: "calendar",
            calendar: { dateFieldId: field("loans.due_date") },
          },
        },
      },
    ],
    forms: [
      {
        key: "add_item",
        table: "items",
        name: t.addItem,
        config: {
          title: t.addItem,
          submitLabel: t.addItem,
          successMessage: t.itemAdded,
          fields: [
            {
              kind: "user_input",
              fieldId: field("items.name"),
              label: t.itemName,
              helpText: t.itemNameHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("items.category"),
              label: t.category,
              helpText: t.categoryHelp,
              inlineCreate: {
                enabled: true,
                fields: [
                  {
                    fieldId: field("categories.name"),
                    label: t.categoryName,
                    helpText: t.categoryNameHelp,
                    required: true,
                  },
                ],
              },
            },
            {
              kind: "user_input",
              fieldId: field("items.location"),
              label: t.location,
              helpText: t.locationHelp,
              inlineCreate: {
                enabled: true,
                fields: [
                  {
                    fieldId: field("locations.name"),
                    label: t.locationName,
                    helpText: t.locationNameHelp,
                    required: true,
                  },
                  {
                    fieldId: field("locations.room"),
                    label: t.room,
                    helpText: t.roomHelp,
                  },
                  {
                    fieldId: field("locations.shelf"),
                    label: t.shelf,
                    helpText: t.shelfHelp,
                  },
                ],
              },
            },
            {
              kind: "user_input",
              fieldId: field("items.status"),
              label: t.status,
              helpText: t.statusHelp,
              defaultValue: ["available"],
            },
            {
              kind: "user_input",
              fieldId: field("items.condition"),
              label: t.condition,
              helpText: t.conditionHelp,
            },
            {
              kind: "user_input",
              fieldId: field("items.tags"),
              label: t.tags,
              helpText: t.tagsHelp,
            },
            {
              kind: "user_input",
              fieldId: field("items.quantity"),
              label: t.quantity,
              helpText: t.quantityHelp,
              required: true,
              defaultValue: "1",
            },
            {
              kind: "user_input",
              fieldId: field("items.replacement_value"),
              label: t.replacementValue,
              helpText: t.replacementValueHelp,
            },
            {
              kind: "user_input",
              fieldId: field("items.notes"),
              label: t.notes,
              helpText: t.notesHelp,
            },
          ],
        },
      },
      {
        key: "request_loan",
        table: "loans",
        name: t.requestLoan,
        isPublic: true,
        config: {
          title: t.requestKitLoan,
          description: t.requestKitLoanDescription,
          submitLabel: t.requestLoan,
          successMessage: t.loanRequested,
          fields: [
            {
              kind: "user_input",
              fieldId: field("loans.requester_name"),
              label: t.requesterFormName,
              helpText: t.requesterNameHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("loans.requester_email"),
              label: t.email,
              helpText: t.emailHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("loans.organization"),
              label: t.organization,
              helpText: t.organizationHelp,
            },
            {
              kind: "user_input",
              fieldId: field("loans.kits"),
              label: t.kits,
              helpText: t.kitsHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("loans.start_date"),
              label: t.startDate,
              helpText: t.startDateHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("loans.due_date"),
              label: t.dueDate,
              helpText: t.dueDateHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("loans.purpose"),
              label: t.purpose,
              helpText: t.purposeHelp,
            },
            {
              kind: "form_value",
              fieldId: field("loans.status"),
              value: ["requested"],
            },
            {
              kind: "form_value",
              fieldId: field("loans.availability_confirmed"),
              value: false,
            },
            {
              kind: "form_value",
              fieldId: field("loans.agreement_sent"),
              value: false,
            },
          ],
        },
      },
    ],
    customApps: [
      {
        key: "equipment_loans",
        definition: {
          schemaVersion: 5,
          kind: "grids.custom-app",
          name: t.equipmentLoans,
          icon: "package",
          sidebar: {
            actions: [
              {
                id: "new-loan",
                kind: "form",
                label: t.newLoan,
                icon: "plus",
                tone: "success",
                formId: form("request_loan"),
                fixedValues: {},
                onSuccessNavigate: {
                  kind: "navigate",
                  pageId: "loan",
                  params: { loan_id: { source: "RESULT", path: "recordId" } },
                },
              },
            ],
          },
          startPageId: "home",
          pages: [
            {
              id: "home",
              title: t.myEquipmentLoans,
              navigation: { visible: true, icon: "home" },
              parameters: {},
              rows: [
                {
                  id: "welcome",
                  columns: [
                    {
                      id: "content",
                      span: 12,
                      blocks: [
                        {
                          id: "guidance",
                          type: "markdown",
                          markdown: t.equipmentLoansGuidance,
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "loans",
                  columns: [
                    {
                      id: "content",
                      span: 12,
                      blocks: [
                        {
                          id: "my-loans",
                          type: "records",
                          title: t.myLoans,
                          emptyText: t.noEquipmentLoans,
                          source: {
                            kind: "gql",
                            query: formula(
                              "from table ",
                              table("loans"),
                              "\nwhere record.createdBy = @auth.id\nselect ",
                              field("loans.loan_no"),
                              ", ",
                              field("loans.purpose"),
                              ", ",
                              field("loans.start_date"),
                              ", ",
                              field("loans.due_date"),
                              ", ",
                              field("loans.status"),
                              "\nsort record.createdAt desc",
                            ),
                          },
                          display: { kind: "table", columnIds: [] },
                          searchable: true,
                          pageSize: 25,
                          rowNavigate: {
                            kind: "navigate",
                            pageId: "loan",
                            history: "push",
                            params: { loan_id: { source: "ROW", path: "id" } },
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              id: "catalog",
              title: t.equipmentCatalog,
              navigation: { visible: true, icon: "package" },
              parameters: {},
              rows: [
                {
                  id: "catalog",
                  columns: [
                    {
                      id: "content",
                      span: 12,
                      blocks: [
                        {
                          id: "available-items",
                          type: "records",
                          title: t.availableEquipment,
                          emptyText: t.noAvailableEquipment,
                          source: { kind: "view", viewId: view("available_items") },
                          display: { kind: "cards" },
                          searchable: true,
                          pageSize: 25,
                          rowNavigate: {
                            kind: "navigate",
                            pageId: "item",
                            history: "push",
                            params: { item_id: { source: "ROW", path: "id" } },
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              id: "loan",
              title: t.loanDetails,
              navigation: { visible: false },
              parameters: { loan_id: { type: "record", tableId: table("loans"), required: true } },
              record: { tableId: table("loans"), id: { source: "PARAMS", path: "loan_id" } },
              availableWhen: {
                query: formula(
                  "from table ",
                  table("loans"),
                  "\nwhere record.id = @params.loan_id and record.createdBy = @auth.id\nlimit 1",
                ),
              },
              rows: [
                {
                  id: "detail",
                  columns: [
                    {
                      id: "loan",
                      span: 8,
                      blocks: [
                        {
                          id: "loan",
                          type: "record",
                          title: t.loanOverview,
                          fieldIds: [
                            field("loans.loan_no"),
                            field("loans.requester_name"),
                            field("loans.requester_email"),
                            field("loans.organization"),
                            field("loans.kits"),
                            field("loans.start_date"),
                            field("loans.due_date"),
                            field("loans.status"),
                            field("loans.purpose"),
                          ],
                          editableFieldIds: [],
                        },
                      ],
                    },
                    {
                      id: "updates",
                      span: 4,
                      blocks: [
                        {
                          id: "actions",
                          type: "actions",
                          actions: [
                            {
                              id: "cancel",
                              label: t.cancelRequest,
                              icon: "calendar-x",
                              kind: "workflow",
                              launcherId: launcher("cancel_loan_custom_app"),
                              inputs: { loan: { source: "RECORD", path: "id" } },
                              confirm: t.cancelRequestConfirm,
                              availableWhen: {
                                query: formula(
                                  "from table ",
                                  table("loans"),
                                  "\nwhere record.id = @params.loan_id and ",
                                  field("loans.status"),
                                  " = 'requested'\nlimit 1",
                                ),
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "updates",
                  columns: [
                    {
                      id: "comments",
                      span: 12,
                      blocks: [
                        {
                          id: "comments",
                          type: "comments",
                          title: t.questionsAndUpdates,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              id: "item",
              title: t.equipmentDetails,
              navigation: { visible: false },
              parameters: { item_id: { type: "record", tableId: table("items"), required: true } },
              record: { tableId: table("items"), id: { source: "PARAMS", path: "item_id" } },
              rows: [
                {
                  id: "item",
                  columns: [
                    {
                      id: "content",
                      span: 12,
                      blocks: [
                        {
                          id: "item",
                          type: "record",
                          fieldIds: [
                            field("items.asset_id"),
                            field("items.name"),
                            field("items.category"),
                            field("items.location"),
                            field("items.status"),
                            field("items.condition"),
                            field("items.files"),
                            field("items.notes"),
                          ],
                          editableFieldIds: [],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      {
        key: "loan_desk",
        definition: {
          schemaVersion: 5,
          kind: "grids.custom-app",
          name: t.loanDesk,
          icon: "clipboard-check",
          startPageId: "dashboard",
          pages: [
            {
              id: "dashboard",
              title: t.loanDesk,
              navigation: { visible: true },
              parameters: {},
              rows: [
                {
                  id: "metrics",
                  columns: [
                    {
                      id: "open",
                      span: 4,
                      blocks: [
                        {
                          id: "open-loans",
                          type: "metrics",
                          title: t.openLoans,
                          source: {
                            kind: "gql",
                            query: formula(
                              "from table ",
                              table("loans"),
                              "\nwhere oneof(",
                              field("loans.status"),
                              ", 'requested', 'approved', 'active')\naggregate count(*) as open_loans",
                            ),
                          },
                        },
                      ],
                    },
                    {
                      id: "overdue",
                      span: 4,
                      blocks: [
                        {
                          id: "overdue-loans",
                          type: "metrics",
                          title: t.overdueLoans,
                          source: {
                            kind: "gql",
                            query: formula(
                              "from table ",
                              table("loans"),
                              "\nwhere ",
                              field("loans.due_date"),
                              " < @time.today and ",
                              field("loans.status"),
                              " = 'active'\naggregate count(*) as overdue_loans",
                            ),
                          },
                        },
                      ],
                    },
                    {
                      id: "stock",
                      span: 4,
                      blocks: [
                        {
                          id: "available-items",
                          type: "metrics",
                          title: t.availableItems,
                          source: {
                            kind: "gql",
                            query: formula(
                              "from table ",
                              table("items"),
                              "\nwhere ",
                              field("items.status"),
                              " = 'available'\naggregate count(*) as available_items",
                            ),
                          },
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "queue",
                  columns: [
                    {
                      id: "content",
                      span: 12,
                      blocks: [
                        {
                          id: "loan-queue",
                          type: "records",
                          title: t.operationalLoanQueue,
                          emptyText: t.noOpenLoans,
                          source: { kind: "view", viewId: view("open_loans") },
                          display: { kind: "table", columnIds: viewColumns("open_loans") },
                          searchable: true,
                          pageSize: 25,
                          rowNavigate: {
                            kind: "navigate",
                            pageId: "loan",
                            history: "push",
                            params: { loan_id: { source: "ROW", path: "id" } },
                          },
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "inventory-value",
                  columns: [
                    {
                      id: "value",
                      span: 4,
                      blocks: [
                        {
                          id: "w-value",
                          type: "metrics",
                          title: t.inventoryValue,
                          source: {
                            kind: "gql",
                            query: formula(
                              "from table ",
                              table("items"),
                              "\naggregate sum(formula(",
                              field("items.quantity"),
                              " * ",
                              field("items.replacement_value"),
                              ")) as inventory_value",
                            ),
                          },
                        },
                      ],
                    },
                    {
                      id: "status",
                      span: 8,
                      blocks: [
                        {
                          id: "loan-status",
                          type: "chart",
                          title: t.loansByStatus,
                          chartType: "donut",
                          source: {
                            kind: "gql",
                            query: formula(
                              "from table ",
                              table("loans"),
                              "\ngroup by ",
                              field("loans.status"),
                              "\naggregate count(*) as loans\nsort loans desc",
                            ),
                          },
                          limit: 20,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              id: "returns",
              title: t.returns,
              navigation: { visible: true, icon: "scan" },
              parameters: {},
              rows: [
                {
                  id: "returns",
                  columns: [
                    {
                      id: "damage",
                      span: 12,
                      blocks: [
                        {
                          id: "report-defect",
                          type: "scanner",
                          title: t.reportDamagedItem,
                          launcherId: launcher("report_item_defect_scanner"),
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              id: "loan",
              title: t.loanAdministration,
              navigation: { visible: false },
              parameters: { loan_id: { type: "record", tableId: table("loans"), required: true } },
              record: { tableId: table("loans"), id: { source: "PARAMS", path: "loan_id" } },
              rows: [
                {
                  id: "loan",
                  columns: [
                    {
                      id: "detail",
                      span: 8,
                      blocks: [
                        {
                          id: "loan",
                          type: "record",
                          title: t.loanAndHandover,
                          fieldIds: [
                            field("loans.loan_no"),
                            field("loans.requester_name"),
                            field("loans.requester_email"),
                            field("loans.organization"),
                            field("loans.kits"),
                            field("loans.items"),
                            field("loans.start_date"),
                            field("loans.due_date"),
                            field("loans.returned_at"),
                            field("loans.status"),
                            field("loans.availability_confirmed"),
                            field("loans.agreement_sent"),
                            field("loans.purpose"),
                            field("loans.notes"),
                          ],
                          editableFieldIds: [
                            field("loans.kits"),
                            field("loans.items"),
                            field("loans.start_date"),
                            field("loans.due_date"),
                            field("loans.returned_at"),
                            field("loans.status"),
                            field("loans.availability_confirmed"),
                            field("loans.notes"),
                          ],
                        },
                      ],
                    },
                    {
                      id: "actions",
                      span: 4,
                      blocks: [
                        {
                          id: "actions",
                          type: "actions",
                          actions: [
                            {
                              id: "approve",
                              label: t.approveLoan,
                              icon: "check",
                              kind: "workflow",
                              launcherId: launcher("approve_loan_custom_app"),
                              inputs: { loan: { source: "RECORD", path: "id" } },
                              confirm: t.approveLoanConfirm,
                              availableWhen: {
                                query: formula(
                                  "from table ",
                                  table("loans"),
                                  "\nwhere record.id = @params.loan_id and ",
                                  field("loans.status"),
                                  " = 'requested'\nlimit 1",
                                ),
                              },
                            },
                            {
                              id: "send-agreement",
                              label: t.sendAgreementAndStartLoan,
                              icon: "file-check",
                              kind: "workflow",
                              launcherId: launcher("send_loan_agreement_custom_app"),
                              inputs: { loan: { source: "RECORD", path: "id" } },
                              confirm: t.sendAgreementConfirm,
                              availableWhen: {
                                query: formula(
                                  "from table ",
                                  table("loans"),
                                  "\nwhere record.id = @params.loan_id and ",
                                  field("loans.status"),
                                  " = 'approved' and ",
                                  field("loans.agreement_sent"),
                                  " = false\nlimit 1",
                                ),
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "updates",
                  columns: [
                    {
                      id: "comments",
                      span: 12,
                      blocks: [
                        {
                          id: "comments",
                          type: "comments",
                          title: t.loanNotesAndUpdates,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
    documentTemplates: [
      {
        key: "asset_label",
        table: "items",
        starterId: "label",
        name: t.assetLabel,
        description: t.assetLabelDescription,
        source: formula(
          "from table ",
          table("items"),
          "\nselect ",
          field("items.asset_id"),
          ", ",
          field("items.name"),
          ", ",
          field("items.location"),
          "\nwhere record.id = '{{ record.id }}'\nlimit 1",
        ),
        enabled: true,
      },
      {
        key: "loan_agreement",
        table: "loans",
        starterId: "loan-agreement",
        name: t.loanAgreement,
        description: t.loanAgreementDescription,
        source: formula(
          "from table ",
          table("loans"),
          "\nselect ",
          field("loans.loan_no"),
          " as loan_number",
          ", ",
          field("loans.requester_name"),
          " as borrower_name",
          ", ",
          field("loans.requester_email"),
          " as borrower_email",
          ", ",
          field("loans.organization"),
          " as borrower_organization",
          ", ",
          field("loans.kits"),
          ", ",
          field("loans.start_date"),
          " as loan_start",
          ", ",
          field("loans.due_date"),
          " as return_due",
          ", ",
          field("loans.purpose"),
          "\nwhere record.id = '{{ record.id }}'\nlimit 1",
        ),
        enabled: true,
      },
    ],
    emailTemplates: [
      {
        key: "loan_agreement_ready",
        name: t.loanAgreementReady,
        description: t.loanAgreementReadyDescription,
        subject: t.loanAgreementSubject,
        html: t.loanAgreementEmail,
        sampleData: {
          requesterName: "Alex Morgan",
          loanNumber: "LOAN-2026-0001",
          dueDate: t.sampleDueDate,
          agreement: {
            url: "https://cloud.example.org/share/grids/documents/example",
          },
        },
        enabled: true,
      },
    ],
    workflows: [
      {
        key: "cancel_loan",
        name: t.cancelRequestedLoan,
        description: t.cancelRequestedLoanDescription,
        source: `inputs:
  loan:
    type: record
    table: ${t.loans}
    label: ${t.workflowLoanLabel}
    required: true
steps:
  - if:
      notEquals:
        - \${{ inputs.loan.${t.status} }}
        - [requested]
    then:
      - fail:
          message: ${t.onlyRequestedLoanCanBeCancelled}
  - updateRecord:
      record: inputs.loan
      set:
        ${t.status}: [cancelled]
  - succeed:
      message: "${t.loanCancelled({ loanNumber: workflowRefs.loanNumber })}"`,
        enabled: true,
      },
      {
        key: "approve_loan",
        name: t.approveEquipmentLoan,
        description: t.approveEquipmentLoanDescription,
        source: `inputs:
  loan:
    type: record
    table: ${t.loans}
    label: ${t.workflowLoanLabel}
    required: true
steps:
  - if:
      notEquals:
        - \${{ inputs.loan.${t.status} }}
        - [requested]
    then:
      - fail:
          message: ${t.onlyRequestedLoanCanBeApproved}
  - if:
      notEquals:
        - \${{ inputs.loan.${t.scheduleValid} }}
        - true
    then:
      - fail:
          message: ${t.dueDateMustFollowStartDate}
  - if:
      notEquals:
        - \${{ inputs.loan.${t.availabilityConfirmed} }}
        - true
    then:
      - fail:
          message: ${t.confirmAvailabilityBeforeApproval}
  - updateRecord:
      record: inputs.loan
      set:
        ${t.status}: [approved]
  - succeed:
      message: "${t.loanApproved({ loanNumber: workflowRefs.loanNumber })}"`,
        enabled: true,
      },
      {
        key: "send_loan_agreement",
        name: t.sendApprovedLoanAgreement,
        description: t.sendApprovedLoanAgreementDescription,
        source: `inputs:
  loan:
    type: record
    table: ${t.loans}
    label: ${t.workflowLoanLabel}
    required: true
steps:
  - if:
      notEquals:
        - \${{ inputs.loan.${t.status} }}
        - [approved]
    then:
      - fail:
          message: ${t.approveBeforeSendingAgreement}
  - if:
      equals:
        - \${{ inputs.loan.${t.agreementSent} }}
        - true
    then:
      - fail:
          message: ${t.agreementAlreadySent}
  - if:
      notEquals:
        - \${{ inputs.loan.${t.availabilityConfirmed} }}
        - true
    then:
      - fail:
          message: ${t.confirmAvailabilityBeforeSending}
  - if:
      notEquals:
        - \${{ inputs.loan.${t.scheduleValid} }}
        - true
    then:
      - fail:
          message: ${t.dueDateMustFollowStartDate}
  - if:
      not:
        exists: inputs.loan.${t.requesterEmail}
    then:
      - fail:
          message: ${t.addRequesterEmail}
  - if:
      endsWith:
        - \${{ inputs.loan.${t.requesterEmail} }}
        - .test
    then:
      - fail:
          message: ${t.replaceSampleEmail}
  - generateDocument:
      template: ${t.loanAgreement}
      record: inputs.loan
      saveAs: agreementPdf
  - createDocumentLink:
      document: agreementPdf
      expiresIn: 30d
      saveAs: agreementLink
  - sendEmail:
      template: ${t.loanAgreementReady}
      to:
        - email: \${{ inputs.loan.${t.requesterEmail} }}
      data:
        agreement: \${{ agreementLink }}
        loanNumber: \${{ inputs.loan.${t.loanNumber} }}
        requesterName: \${{ inputs.loan.${t.requesterName} }}
        dueDate: \${{ inputs.loan.${t.dueDate} }}
  - updateRecord:
      record: inputs.loan
      set:
        ${t.agreementSent}: true
        ${t.status}: [active]
  - succeed:
      message: "${t.agreementSentMessage({ loanNumber: workflowRefs.loanNumber })}"`,
        enabled: true,
      },
      {
        key: "report_item_defect",
        name: t.reportDamagedItem,
        description: t.reportDamagedItemDescription,
        source: `inputs:
  item:
    type: record
    table: ${t.items}
    label: ${t.inventoryItem}
    required: true
steps:
  - if:
      equals:
        - \${{ inputs.item.${t.status} }}
        - [maintenance]
    then:
      - fail:
          message: "${t.itemAlreadyInMaintenance({ assetId: workflowRefs.assetId })}"
  - updateRecord:
      record: inputs.item
      set:
        ${t.status}: [maintenance]
        ${t.condition}: [repair]
  - succeed:
      message: "${t.itemMovedToMaintenance({ assetId: workflowRefs.assetId, name: workflowRefs.itemName })}"`,
        enabled: true,
      },
      {
        key: "return_loan_item",
        name: t.markLoanItemReturned,
        description: t.markLoanItemReturnedDescription,
        source: `inputs:
  loan:
    type: record
    table: ${t.loans}
    label: ${t.loanAgreement}
    description: ${t.returnLoanDescription}
    required: true
  item:
    type: record
    table: ${t.items}
    label: ${t.returnedItem}
    required: true
  condition:
    type: select
    label: ${t.returnedCondition}
    description: ${t.returnedConditionDescription}
    options:
      - good
      - used
      - repair
    required: true
steps:
  - if:
      notEquals:
        - \${{ inputs.loan.${t.status} }}
        - [active]
    then:
      - fail:
          message: "${t.loanNotActive({ loanNumber: workflowRefs.loanNumber })}"
  - if:
      not:
        includes:
          - \${{ inputs.loan.${t.loanedItems} }}
          - \${{ inputs.item }}
    then:
      - fail:
          message: "${t.itemNotInLoan({ assetId: workflowRefs.assetId, loanNumber: workflowRefs.loanNumber })}"
  - if:
      notEquals:
        - \${{ inputs.item.${t.status} }}
        - [in_use]
    then:
      - fail:
          message: "${t.itemNotInUse({ assetId: workflowRefs.assetId })}"
  - if:
      equals:
        - \${{ inputs.condition }}
        - repair
    then:
      - updateRecord:
          record: inputs.item
          set:
            ${t.status}: [maintenance]
            ${t.condition}: [repair]
      - succeed:
          message: "${t.itemReturnedForRepair({ assetId: workflowRefs.assetId, loanNumber: workflowRefs.loanNumber })}"
  - updateRecord:
      record: inputs.item
      set:
        ${t.status}: [available]
        ${t.condition}:
          - \${{ inputs.condition }}
  - succeed:
      message: "${t.itemReturnedWithCondition({
        assetId: workflowRefs.assetId,
        condition: workflowRefs.condition,
        loanNumber: workflowRefs.loanNumber,
      })}"`,
        enabled: true,
      },
    ],
    workflowLaunchers: [
      {
        key: "cancel_loan_custom_app",
        workflow: "cancel_loan",
        name: t.cancelRequestedLoan,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "approve_loan_custom_app",
        workflow: "approve_loan",
        name: t.approveEquipmentLoan,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "send_loan_agreement_custom_app",
        workflow: "send_loan_agreement",
        name: t.chooseLoanToSendAgreement,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "report_item_defect_scanner",
        workflow: "report_item_defect",
        name: t.scanDamagedInventoryItem,
        config: {
          kind: "scanner",
          input: "item",
          resolve: { by: "field", field: t.assetId },
        },
        enabled: true,
      },
      {
        key: "return_loan_item_scanner",
        workflow: "return_loan_item",
        name: t.returnItemsForLoan,
        config: {
          kind: "scanner",
          inputSources: {
            loan: { kind: "session" },
            item: {
              kind: "scan",
              value: "record",
              resolve: { by: "field", field: t.assetId },
            },
            condition: { kind: "afterScan" },
          },
        },
        enabled: true,
      },
    ],
  };
};

export const inventoryTemplate: GridTemplate = createInventoryTemplate("en");
