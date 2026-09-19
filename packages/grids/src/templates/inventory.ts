import { createMockCover } from "@k2b/cloud/shared";
import { i18n } from "@k2b/stdlib";
import { inventoryApps } from "./inventory-apps";
import { currentMonthDate, field, formula, type GridTemplate, record, table } from "./types";

const inventoryMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      requestedEquipment: "Requested equipment",
      individualItems: "Individual items",
      individualItemsHelp: "Choose extra items not already included in your selected kits.",
      itemRequestable: "Offer individually in the catalog",
      itemRequestableHelp: "Borrowers can request this item individually when it is available. Internal notes and locations stay private.",
      equipmentSelectionHelp:
        "Combine several kits and individual items in one request. This does not reserve equipment; the loan desk confirms availability.",
      chooseEquipment: "Choose at least one kit or individual item.",
      approvedHelp:
        ":::success Approved · arrange collection\nYour request is approved. Contact the loan desk to collect the assigned equipment. It becomes an active loan when items are handed over.\n:::",
      borrowedHelp:
        ":::info Equipment handed over\nReturn the issued items by the due date. The loan desk records each return; use the messages below if plans change.\n:::",
      returnedHelp:
        ":::success Loan completed\nThe loan desk has recorded all returns and closed this loan. No further action is needed.\n:::",
      rejectedHelp:
        ":::warning Request declined\nSee the reason below. You can discuss alternatives in the messages or submit a new request.\n:::",
      cancelledHelp:
        ":::info Request cancelled\nNo equipment will be handed over for this request. Create a new request when you need equipment again.\n:::",
      allocatedEquipment: "Assigned equipment",
      requestedKitContents: "What the selected kits contain",
      kitContentsColumn: "Contents",
      loanDocuments: "Agreement and documents",
      loanDates: "Loan period",
      deskContact: "Borrower contact",
      handoverReadyHelp:
        ":::success Ready for handover\nOpen each assigned item when handing it over and choose Issue loan position. Sending the agreement is optional and does not mark items as handed over.\n:::",
      completeRepair: "Mark repaired",
      completeRepairHelp: "Confirm that this item was checked and is ready to use again.",
      repairCompleted: "Item available again.",
      cancelPosition: "Cancel planned position",
      cancelPositionHelp: "Remove this item from the planned handover? Issued items must be returned instead.",
      positionCancelled: "Planned position cancelled.",
      rejectLoan: "Reject request",
      rejectConfirm: "Reject this request? No equipment will be handed over.",
      rejectionReason: "Reason for rejection",
      loanRejected: "Request rejected.",
      addKit: "Create kit",
      kitAdded: "Kit created.",
      editKit: "Edit kit",
      kitCatalogHelp:
        "Maintain the sets offered to borrowers. Only requestable kits with Available status appear in their catalog. Check individual items before every handover.",
      catalogHelp:
        ":::info Choose equipment\nBrowse kits and individual items. Open **New loan** to combine your selection in one request. A request is not a reservation; the loan desk checks availability before approval.\n:::",
      deskHelp:
        ":::info Your next handover\nReview requests, assign individual items, then confirm availability and approve. Issue each item when handing it over. Sending an agreement is optional. Record returns before closing the loan.\n:::",
      returnHelp:
        ":::info Return an item\nScan its asset label, or open an in-use item under Inventory. Choose its returned condition. Damaged items stay unavailable until repaired.\n:::",
      requestedHelp:
        ":::info Request received\nThe loan desk will check the dates and available items. Approval does not mean that equipment has already been handed over.\n:::",
      prepareHelp:
        ":::info Prepare this request\nAdd the individual items below. Check their availability for the requested dates, then edit the loan to confirm availability. Approval freezes allocation planning.\n:::",
      activeHelp:
        ":::info Handover and return\nOpen a planned position to issue that item. For a return, open the item or use the scanner. Close the loan only after every position has been returned.\n:::",
      editLoan: "Edit loan details",
      editItem: "Edit item details",
      saveChanges: "Save changes",
      changesSaved: "Changes saved.",
      loanSchedule: "Dates and allocation",
      contactDetails: "Contact details",
      additionalDetails: "Additional details",
      awaitingReview: "Requests to review",
      upcomingHandovers: "Approved · ready for handover",
      activeLoans: "Handovers and returns",
      loanArchive: "Completed requests",
      emptyReview: "No requests need review.",
      emptyApproved: "No approved loans waiting for handover.",
      emptyActive: "No active loans are due today or later.",
      emptyOverdue: "No overdue returns. Thank you for keeping the equipment moving.",
      emptyPositions: "No items assigned yet. Add the individual items below before approving this request.",
      emptyInventory: "No items yet. Add your first item to start tracking handovers.",
      demoRejection: "The requested kit is already allocated for this period.",
      emptyArchive: "Completed and cancelled requests will appear here.",
      inventory: "Inventory",
      browseStock: "Find an item by its name or asset ID. Open it to view its location, register a return, or update its details.",
      kitDetails: "Kit details",
      noKits: "No kits are currently offered for requests.",
      positionDetails: "Handover position",
      openItem: "Open item",
      positionHelp:
        "The position records one physical handover. Issue it once; record its return on the item, where you also choose the returned condition.",

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
      quantityDescription: "One individually labelled item per record. Model bulk stock separately.",
      loanPositions: "Loan positions",
      positionNumber: "Position number",
      positionLoan: "Loan",
      positionItem: "Item",
      currentPosition: "Current loan position",
      currentPositionDescription: "The exact issued position currently holding this item. Issue and return workflows maintain this link.",
      issuedAt: "Issued at",
      planned: "Planned",
      issuePosition: "Issue loan position",
      addPosition: "Add loan position",
      closeLoan: "Close returned loan",
      positionUnavailable: "The position, item or loan is no longer ready for this operation. Refresh and inspect the current allocation.",
      positionIssued: "Item issued. Its loan position records this handover.",
      positionReturned: "Item returned. Its loan position records the return and condition.",
      noCurrentPosition: "This item has no current loan position to return.",
      outstandingPositions:
        "This operation needs loan positions. Before closing, every planned position must have been issued and returned.",
      loanClosed: "Loan closed. Every loan position has been returned.",
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
      requesterNameDescription: "Person requesting or borrowing the equipment.",
      requesterEmail: "Requester email",
      requesterEmailDescription: "Email address for loan communication.",
      organization: "Organization",
      organizationDescription: "Optional team, department, or external organization.",
      loanKitsDescription: "Kits requested for this loan. Actual handovers are tracked separately.",
      loanedItems: "Loaned items",
      loanedItemsDescription: "Specific inventory records handed out under this loan.",
      requestedFrom: "Requested from",
      requestedFromDescription: "Requested start date for the loan.",
      dueDate: "Due date",
      dueDateDescription: "Expected return date for borrowed equipment.",
      scheduleValid: "Schedule valid",
      scheduleValidDescription: "Whether the return date is on or after the requested start date.",
      returnedAt: "Returned at",
      returnedAtDescription: "Actual date when the equipment was returned.",
      loanStatusDescription: "Current approval and return status.",
      requested: "Requested",
      approved: "Approved",
      active: "Active",
      returned: "Returned",
      rejected: "Rejected",
      cancelled: "Cancelled",
      availabilityConfirmed: "Availability confirmed",
      availabilityConfirmedDescription: "The loan desk has checked the requested equipment and dates before approval.",
      agreementSent: "Agreement delivery",
      agreementSentDescription:
        "Ready, in progress, or sent. Inspect the original run before resetting an interrupted delivery; it may already have sent email.",
      deliveryReady: "Ready",
      deliveryProcessing: "In progress",
      deliverySent: "Sent",
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
      quantityHelp: "One individually labelled item per record. Add another record for another physical item.",
      replacementValueHelp: "Cost to replace one unit.",
      notesHelp: "Extra context for admins.",
      requestLoan: "Request loan",
      requestKitLoan: "Request equipment",
      requestKitLoanDescription: "Enter your contact details and dates. The loan desk checks availability before approving your request.",
      loanRequested: "Loan requested.",
      requesterFormName: "Name",
      requesterNameHelp: "Who will collect the equipment.",
      email: "Email",
      emailHelp: "Contact address for questions and approval.",
      organizationHelp: "Team, company, or project.",
      kitsHelp: "Choose one or more kits to borrow.",
      startDate: "Start date",
      startDateHelp: "First planned day of use.",
      dueDateHelp: "Planned return date.",
      purposeHelp: "What the equipment will be used for.",
      equipmentLoans: "Equipment loans",
      newLoan: "New loan",
      myEquipmentLoans: "My equipment loans",
      equipmentLoansGuidance:
        "Combine kits and individual items with **New loan**. Open an existing loan to see its status or send a message.",
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
      sendAgreementAndStartLoan: "Send agreement by email",
      sendAgreementConfirm: "Send the agreement to the borrower by email? This does not hand over any items.",
      loanNotesAndUpdates: "Messages shared with the borrower",
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
      agreementAlreadySent: "Agreement delivery is not ready. Inspect the original workflow run and existing documents before retrying.",
      confirmAvailabilityBeforeSending: "Confirm kit, item, and date availability before sending the agreement.",
      addRequesterEmail: "Add a requester email address before sending this agreement.",
      replaceSampleEmail: "Replace the sample requester email before sending a real agreement.",
      agreementSentMessage: ({ loanNumber }: { loanNumber: string }) => `Agreement for loan ${loanNumber} sent.`,
      reportDamagedItemDescription: "Moves a scanned inventory item into maintenance and marks it as needing repair.",
      inventoryItem: "Inventory item",
      itemAlreadyInMaintenance: ({ assetId }: { assetId: string }) => `Item ${assetId} is already in maintenance.`,
      itemMovedToMaintenance: ({ assetId, name }: { assetId: string; name: string }) => `Item ${assetId} · ${name} moved to maintenance.`,
      markLoanItemReturned: "Mark loan item as returned",
      markLoanItemReturnedDescription:
        "Returns the scanned item's current loan position and records its condition. No historical loan selection is needed.",
      returnedItem: "Returned item",
      returnedCondition: "Returned condition",
      returnedConditionDescription: "Check the returned item. Damaged items go to maintenance and remain unavailable.",
      chooseLoanToSendAgreement: "Choose loan to send agreement",
      scanDamagedInventoryItem: "Scan damaged inventory item",
      returnItemsForLoan: "Scan returned inventory item",
    },
    de: {
      requestedEquipment: "Angefragte Ausrüstung",
      individualItems: "Einzelgeräte",
      individualItemsHelp: "Wähle zusätzliche Geräte, die nicht bereits in deinen Sets enthalten sind.",
      itemRequestable: "Einzeln im Katalog anbieten",
      itemRequestableHelp:
        "Dieses Gerät kann bei verfügbarem Bestand einzeln angefragt werden. Interne Notizen und Lagerorte bleiben privat.",
      equipmentSelectionHelp:
        "Kombiniere mehrere Sets und Einzelgeräte in einer Anfrage. Das reserviert noch keine Geräte; die Ausleihe bestätigt die Verfügbarkeit.",
      chooseEquipment: "Wähle mindestens ein Set oder Einzelgerät.",
      approvedHelp:
        ":::success Freigegeben · Abholung vereinbaren\nDeine Anfrage ist freigegeben. Vereinbare die Abholung mit der Ausleihe. Sobald Geräte übergeben werden, beginnt die aktive Ausleihe.\n:::",
      borrowedHelp:
        ":::info Geräte übergeben\nGib die ausgegebenen Geräte bis zum Rückgabedatum zurück. Die Ausleihe erfasst jede Rückgabe. Wenn sich deine Pläne ändern, nutze die Nachrichten unten.\n:::",
      returnedHelp:
        ":::success Ausleihe abgeschlossen\nAlle Rückgaben sind erfasst und die Ausleihe ist abgeschlossen. Du musst nichts mehr tun.\n:::",
      rejectedHelp:
        ":::warning Anfrage abgelehnt\nDen Grund findest du unten. Besprich Alternativen in den Nachrichten oder stelle eine neue Anfrage.\n:::",
      cancelledHelp:
        ":::info Anfrage storniert\nFür diese Anfrage werden keine Geräte ausgegeben. Erstelle bei Bedarf eine neue Anfrage.\n:::",
      allocatedEquipment: "Zugeordnete Geräte",
      requestedKitContents: "Inhalt der ausgewählten Sets",
      kitContentsColumn: "Inhalt",
      loanDocuments: "Vereinbarung und Dokumente",
      loanDates: "Ausleihzeitraum",
      deskContact: "Kontakt zur ausleihenden Person",
      handoverReadyHelp:
        ":::success Bereit zur Übergabe\nÖffne bei der Übergabe jedes zugeordnete Gerät und wähle Ausleihposition ausgeben. Der optionale Versand der Vereinbarung erfasst noch keine Übergabe.\n:::",
      completeRepair: "Reparatur abschließen",
      completeRepairHelp: "Bestätige, dass dieses Gerät geprüft wurde und wieder einsatzbereit ist.",
      repairCompleted: "Gerät wieder verfügbar.",
      cancelPosition: "Geplante Position stornieren",
      cancelPositionHelp: "Dieses Gerät aus der geplanten Übergabe entfernen? Bereits ausgegebene Geräte müssen zurückgegeben werden.",
      positionCancelled: "Geplante Position storniert.",
      rejectLoan: "Anfrage ablehnen",
      rejectConfirm: "Diese Anfrage ablehnen? Es werden keine Geräte ausgegeben.",
      rejectionReason: "Grund der Ablehnung",
      loanRejected: "Anfrage abgelehnt.",
      addKit: "Set erstellen",
      kitAdded: "Set erstellt.",
      editKit: "Set bearbeiten",
      kitCatalogHelp:
        "Pflege die angebotenen Sets. Im Katalog erscheinen nur anfragbare Sets mit Status Verfügbar. Prüfe vor jeder Übergabe die einzelnen Geräte.",
      catalogHelp:
        ":::info Ausrüstung auswählen\nEntdecke Sets und Einzelgeräte. Kombiniere sie über **Neue Ausleihe** in einer gemeinsamen Anfrage. Eine Anfrage ist keine Reservierung: Die Ausleihe prüft die Verfügbarkeit vor der Freigabe.\n:::",
      deskHelp:
        ":::info Die nächste Übergabe\nPrüfe Anfragen und ordne einzelne Geräte zu. Bestätige die Verfügbarkeit und gib die Ausleihe frei. Gib jedes Gerät bei der Übergabe aus. Der Versand einer Vereinbarung ist optional. Erfasse alle Rückgaben vor dem Abschluss.\n:::",
      returnHelp:
        ":::info Gerät zurücknehmen\nScanne das Inventaretikett oder öffne ein ausgeliehenes Gerät unter Inventar. Wähle den Zustand bei Rückgabe. Beschädigte Geräte bleiben bis zur Reparatur nicht verfügbar.\n:::",
      requestedHelp:
        ":::info Anfrage eingegangen\nDie Ausleihe prüft Zeitraum und verfügbare Geräte. Eine Freigabe bedeutet noch nicht, dass die Geräte bereits übergeben wurden.\n:::",
      prepareHelp:
        ":::info Anfrage vorbereiten\nOrdne unten die einzelnen Geräte zu und prüfe deren Verfügbarkeit für den Zeitraum. Bestätige sie anschließend unter Ausleihdaten bearbeiten. Nach der Freigabe ist die Zuordnung abgeschlossen.\n:::",
      activeHelp:
        ":::info Übergabe und Rücknahme\nÖffne eine geplante Position, um das Gerät auszugeben. Öffne für die Rückgabe das Gerät oder nutze den Scanner. Schließe die Ausleihe erst ab, wenn alle Positionen zurückgegeben wurden.\n:::",
      editLoan: "Ausleihdaten bearbeiten",
      editItem: "Gerät bearbeiten",
      saveChanges: "Änderungen speichern",
      changesSaved: "Änderungen gespeichert.",
      loanSchedule: "Zeitraum und Zuordnung",
      contactDetails: "Kontaktdaten",
      additionalDetails: "Weitere Angaben",
      awaitingReview: "Anfragen prüfen",
      upcomingHandovers: "Freigegeben · bereit zur Übergabe",
      activeLoans: "Übergaben und Rückgaben",
      loanArchive: "Abgeschlossene Anfragen",
      emptyReview: "Keine Anfragen warten auf Prüfung.",
      emptyApproved: "Keine freigegebenen Ausleihen warten auf ihre Übergabe.",
      emptyActive: "Keine aktiven Ausleihen mit Rückgabe heute oder später.",
      emptyOverdue: "Keine überfälligen Rückgaben. Alle Geräte sind im Zeitplan.",
      emptyPositions: "Noch keine Geräte zugeordnet. Ergänze unten die einzelnen Geräte, bevor du diese Anfrage freigibst.",
      emptyInventory: "Noch keine Geräte vorhanden. Lege dein erstes Gerät an, um Übergaben zu erfassen.",
      demoRejection: "Das angefragte Set ist für diesen Zeitraum bereits vergeben.",
      emptyArchive: "Abgeschlossene und stornierte Anfragen erscheinen hier.",
      inventory: "Inventar",
      browseStock:
        "Suche ein Gerät über Name oder Inventarnummer. Öffne es, um den Lagerort zu sehen, eine Rückgabe zu erfassen oder Angaben zu ändern.",
      kitDetails: "Set-Details",
      noKits: "Aktuell werden keine Sets zur Anfrage angeboten.",
      positionDetails: "Ausleihposition",
      openItem: "Gerät öffnen",
      positionHelp:
        "Diese Position dokumentiert eine einzelne Übergabe. Gib sie einmal aus. Erfasse die Rückgabe beim Gerät und wähle dort den Zustand bei Rückgabe.",

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
      quantityDescription: "Ein einzeln gekennzeichneter Gegenstand pro Datensatz. Mengenbestände separat modellieren.",
      loanPositions: "Ausleihpositionen",
      positionNumber: "Positionsnummer",
      positionLoan: "Ausleihe",
      positionItem: "Gegenstand",
      currentPosition: "Aktuelle Ausleihposition",
      currentPositionDescription:
        "Die ausgegebene Position, die diesen Gegenstand aktuell belegt. Ausgabe- und Rückgabe-Workflows pflegen diese Verknüpfung.",
      issuedAt: "Ausgegeben am",
      planned: "Geplant",
      issuePosition: "Ausleihposition ausgeben",
      addPosition: "Ausleihposition hinzufügen",
      closeLoan: "Zurückgegebene Ausleihe abschließen",
      positionUnavailable:
        "Position, Gegenstand oder Ausleihe ist nicht mehr für diesen Vorgang bereit. Lade die Daten neu und prüfe die aktuelle Zuordnung.",
      positionIssued: "Gegenstand ausgegeben. Die Ausleihposition dokumentiert diese Übergabe.",
      positionReturned: "Gegenstand zurückgegeben. Die Ausleihposition dokumentiert Rückgabe und Zustand.",
      noCurrentPosition: "Dieser Gegenstand hat keine aktuelle Ausleihposition für eine Rückgabe.",
      outstandingPositions:
        "Diese Aktion benötigt Ausleihpositionen. Vor dem Abschluss muss jede geplante Position ausgegeben und zurückgegeben worden sein.",
      loanClosed: "Ausleihe abgeschlossen. Alle Ausleihpositionen wurden zurückgegeben.",
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
      requesterNameDescription: "Person, die die Ausrüstung anfragt oder ausleiht.",
      requesterEmail: "E-Mail der anfragenden Person",
      requesterEmailDescription: "E-Mail-Adresse für die Kommunikation zur Ausleihe.",
      organization: "Organisation",
      organizationDescription: "Optionales Team, Abteilung oder externe Organisation.",
      loanKitsDescription: "Angefragte Sets. Tatsächliche Übergaben werden separat erfasst.",
      loanedItems: "Ausgeliehene Gegenstände",
      loanedItemsDescription: "Konkrete Inventardatensätze, die für diese Ausleihe ausgegeben wurden.",
      requestedFrom: "Angefragt ab",
      requestedFromDescription: "Gewünschtes Startdatum der Ausleihe.",
      dueDate: "Rückgabedatum",
      dueDateDescription: "Erwartetes Rückgabedatum der ausgeliehenen Ausrüstung.",
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
      availabilityConfirmedDescription: "Die Ausleihe hat die angefragte Ausrüstung und den Zeitraum vor der Freigabe geprüft.",
      agreementSent: "Vereinbarungsversand",
      agreementSentDescription:
        "Bereit, in Bearbeitung oder gesendet. Prüfe vor dem Zurücksetzen eines unterbrochenen Versands den ursprünglichen Lauf; die E-Mail könnte bereits gesendet worden sein.",
      deliveryReady: "Bereit",
      deliveryProcessing: "In Bearbeitung",
      deliverySent: "Gesendet",
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
      quantityHelp: "Ein einzeln gekennzeichneter Gegenstand pro Datensatz. Weitere Gegenstände erhalten eigene Datensätze.",
      replacementValueHelp: "Kosten für den Ersatz einer Einheit.",
      notesHelp: "Zusätzlicher Kontext für Personen mit Admin-Rechten.",
      requestLoan: "Ausleihe anfragen",
      requestKitLoan: "Ausrüstung anfragen",
      requestKitLoanDescription: "Ergänze Kontaktdaten und Zeitraum. Die Ausleihe prüft die Verfügbarkeit vor der Freigabe.",
      loanRequested: "Ausleihe angefragt.",
      requesterFormName: "Name",
      requesterNameHelp: "Person, die die Ausrüstung abholt.",
      email: "E-Mail",
      emailHelp: "Kontaktadresse für Rückfragen und die Freigabe.",
      organizationHelp: "Team, Unternehmen oder Projekt.",
      kitsHelp: "Wähle ein oder mehrere Sets zum Ausleihen.",
      startDate: "Startdatum",
      startDateHelp: "Erster geplanter Nutzungstag.",
      dueDateHelp: "Geplantes Rückgabedatum.",
      purposeHelp: "Geplanter Verwendungszweck der Ausrüstung.",
      equipmentLoans: "Geräteausleihen",
      newLoan: "Neue Ausleihe",
      myEquipmentLoans: "Meine Geräteausleihen",
      equipmentLoansGuidance:
        "Kombiniere über **Neue Ausleihe** Sets und Einzelgeräte in einer Anfrage. Öffne eine bestehende Ausleihe, um den Status zu sehen oder eine Nachricht zu schreiben.",
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
      sendAgreementAndStartLoan: "Vereinbarung per E-Mail senden",
      sendAgreementConfirm: "Die Vereinbarung per E-Mail an die ausleihende Person senden? Dadurch wird kein Gerät ausgegeben.",
      loanNotesAndUpdates: "Nachrichten an die ausleihende Person",
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
        "Der Vereinbarungsversand ist nicht bereit. Prüfe vor einem erneuten Versuch den ursprünglichen Workflow-Lauf und vorhandene Dokumente.",
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
        "Gibt die aktuelle Ausleihposition des gescannten Gegenstands zurück und erfasst dessen Zustand. Keine Auswahl einer historischen Ausleihe nötig.",
      returnedItem: "Zurückgegebener Gegenstand",
      returnedCondition: "Zustand bei Rückgabe",
      returnedConditionDescription: "Prüfe das zurückgegebene Gerät. Beschädigte Geräte gehen in die Wartung und bleiben nicht verfügbar.",
      chooseLoanToSendAgreement: "Ausleihe für den Versand der Vereinbarung wählen",
      scanDamagedInventoryItem: "Beschädigten Inventargegenstand scannen",
      returnItemsForLoan: "Zurückgegebenen Inventargegenstand scannen",
    },
  },
});

export type InventoryText = ReturnType<typeof inventoryMessages.resolve>["t"];

export const createInventoryTemplate = (locale?: string): GridTemplate => {
  const { t } = inventoryMessages.resolve(locale ? [locale] : undefined);
  const workflowRefs = {
    assetId: `\${{ inputs.item.${t.assetId} }}`,
    condition: "${{ inputs.condition }}",
    itemName: `\${{ inputs.item.${t.name} }}`,
    loanNumber: `\${{ inputs.loan.${t.loanNumber} }}`,
  };
  const returnPosition = (status: "available" | "maintenance", condition: "good" | "used" | "repair") => `- atomicRecords:
    locks: [inputs.item, position, position.${t.positionLoan}]
    checks:
      - table: ${t.loanPositions}
        where:
          - { field: ${t.positionNumber}, op: equals, value: "\${{ position.${t.positionNumber} }}" }
          - { field: ${t.positionItem}, op: containsAny, value: ["\${{ inputs.item.recordId }}"] }
          - { field: ${t.status}, op: is, value: issued }
        assert: notEmpty
        message: ${t.positionUnavailable}
      - table: ${t.items}
        where:
          - { field: ${t.assetId}, op: equals, value: "\${{ inputs.item.${t.assetId} }}" }
          - { field: ${t.currentPosition}, op: containsAny, value: ["\${{ position.recordId }}"] }
        assert: notEmpty
        message: ${t.positionUnavailable}
    changes:
      - updateRecord:
          record: position
          set:
            ${t.status}: [returned]
            ${t.returnedAt}: \${{ now() }}
            ${t.returnedCondition}: [${condition}]
      - updateRecord:
          record: inputs.item
          set:
            ${t.currentPosition}: null
            ${t.status}: [${status}]
            ${t.condition}: [${condition}]`;

  return {
    id: "inventory",
    name: t.templateName,
    description: t.templateDescription,
    highlights: [t.templateHighlightRecords, t.templateHighlightOverview, t.templateHighlightWorkflows],
    icon: "ti ti-packages",
    baseName: t.templateName,
    baseDescription: t.baseDescription,
    navigationGroups: [
      {
        name: t.loans,
        entries: [
          { type: "customApp", key: "loan_desk" },
          { type: "view", key: "open_loans" },
          { type: "form", key: "request_loan" },
          { type: "workflow", key: "approve_loan" },
          { type: "documentTemplate", key: "loan_agreement" },
        ],
      },
      {
        name: t.items,
        entries: [
          { type: "view", key: "available_items" },
          { type: "form", key: "add_item" },
          { type: "table", key: "kits" },
          { type: "documentTemplate", key: "asset_label" },
        ],
      },
    ],
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
            key: "current_position",
            name: t.currentPosition,
            type: "relation",
            icon: "ti ti-link",
            description: t.currentPositionDescription,
            config: { targetTableId: table("loan_positions"), cardinality: "single" },
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
            key: "requestable",
            name: t.itemRequestable,
            description: t.itemRequestableHelp,
            type: "boolean",
            defaultValue: false,
            icon: "ti ti-world-check",
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
            config: { min: "1", max: "1", decimalPlaces: 0 },
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
            icon: "ti ti-box",
            config: { targetTableId: table("kits"), cardinality: "multiple" },
          },
          {
            key: "requested_items",
            name: t.individualItems,
            description: t.individualItemsHelp,
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
            config: { includeTime: true },
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
            type: "select",
            required: true,
            config: {
              options: [
                { id: "ready", label: t.deliveryReady },
                { id: "processing", label: t.deliveryProcessing },
                { id: "sent", label: t.deliverySent },
              ],
            },
            defaultValue: ["ready"],
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
            key: "rejection_reason",
            name: t.rejectionReason,
            description: t.rejectionReason,
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
      {
        key: "loan_positions",
        name: t.loanPositions,
        description: t.loanedItemsDescription,
        fields: [
          {
            key: "position_no",
            name: t.positionNumber,
            description: t.positionNumber,
            icon: "ti ti-id",
            type: "id",
            presentable: true,
            config: { strategy: "sequence", prefix: "POS-", padding: 4 },
          },
          {
            key: "loan",
            name: t.positionLoan,
            description: t.loanedItemsDescription,
            icon: "ti ti-link",
            type: "relation",
            required: true,
            config: { targetTableId: table("loans"), cardinality: "single" },
          },
          {
            key: "item",
            name: t.positionItem,
            description: t.quantityDescription,
            icon: "ti ti-package",
            type: "relation",
            required: true,
            config: { targetTableId: table("items"), cardinality: "single" },
          },
          {
            key: "status",
            name: t.status,
            description: t.loanStatusDescription,
            icon: "ti ti-progress",
            type: "select",
            required: true,
            defaultValue: ["planned"],
            config: {
              options: [
                { id: "planned", label: t.planned },
                { id: "cancelled", label: t.cancelled },
                { id: "issued", label: t.inUse },
                { id: "returned", label: t.returned },
              ],
            },
          },
          {
            key: "issued_at",
            name: t.issuedAt,
            description: t.issuedAt,
            icon: "ti ti-calendar",
            type: "date",
            config: { includeTime: true },
          },
          {
            key: "returned_at",
            name: t.returnedAt,
            description: t.returnedAtDescription,
            icon: "ti ti-calendar",
            type: "date",
            config: { includeTime: true },
          },
          {
            key: "condition",
            name: t.returnedCondition,
            description: t.returnedConditionDescription,
            icon: "ti ti-stars",
            type: "select",
            config: {
              options: [
                { id: "good", label: t.good },
                { id: "used", label: t.used },
                { id: "repair", label: t.needsRepair },
              ],
            },
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
          status: ["available"],
          requestable: true,
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
          requestable: true,
          condition: ["good"],
          tags: ["portable", "shared"],
          quantity: "1",
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
          requestable: true,
          condition: ["used"],
          tags: ["shared"],
          quantity: "1",
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
          start_date: currentMonthDate(10),
          due_date: currentMonthDate(12),
          status: ["requested"],
          availability_confirmed: false,
          agreement_sent: ["ready"],
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
          rejection_reason: t.demoRejection,
          availability_confirmed: false,
          agreement_sent: ["ready"],
          purpose: t.trainingRecordingPurpose,
        },
      },
      {
        key: "loan_positions.demo",
        table: "loan_positions",
        values: { loan: [record("loans.demo")], item: [record("items.camera")], status: ["planned"] },
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
        key: "kit",
        table: "kits",
        name: t.addKit,
        config: {
          title: t.kits,
          submitLabel: t.saveChanges,
          successMessage: t.changesSaved,
          fields: [
            { kind: "user_input", fieldId: field("kits.name"), required: true, helpText: t.kitNameDescription },
            { kind: "user_input", fieldId: field("kits.category"), width: "compact", helpText: t.kitCategoryDescription },
            { kind: "user_input", fieldId: field("kits.status"), width: "compact", helpText: t.kitStatusDescription },
            { kind: "user_input", fieldId: field("kits.items"), helpText: t.kitItemsDescription },
            { kind: "user_input", fieldId: field("kits.requestable"), helpText: t.requestableDescription },
            { kind: "user_input", fieldId: field("kits.description"), helpText: t.kitDescriptionDescription },
          ],
        },
      },
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
              width: "compact",
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
              width: "compact",
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
              kind: "form_value",
              fieldId: field("items.status"),
              value: ["available"],
            },
            {
              kind: "user_input",
              fieldId: field("items.condition"),
              width: "compact",
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
              kind: "form_value",
              fieldId: field("items.quantity"),
              value: "1",
            },
            {
              kind: "user_input",
              fieldId: field("items.replacement_value"),
              width: "compact",
              label: t.replacementValue,
              helpText: t.replacementValueHelp,
            },
            { kind: "user_input", fieldId: field("items.requestable"), helpText: t.itemRequestableHelp },
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
        isPublic: false,
        config: {
          title: t.requestKitLoan,
          description: t.requestKitLoanDescription,
          submitLabel: t.requestLoan,
          successMessage: t.loanRequested,
          validations: [
            {
              leftFieldId: field("loans.kits"),
              operator: "anyPresent",
              rightFieldId: field("loans.requested_items"),
              errorFieldId: field("loans.kits"),
              message: t.chooseEquipment,
            },
            {
              leftFieldId: field("loans.start_date"),
              operator: "lte",
              rightFieldId: field("loans.due_date"),
              errorFieldId: field("loans.due_date"),
              message: t.dueDateMustFollowStartDate,
            },
          ],
          fields: [
            {
              kind: "user_input",
              section: { title: t.requestedEquipment, description: t.equipmentSelectionHelp },
              fieldId: field("loans.kits"),
              label: t.kits,
              helpText: t.kitsHelp,
              relationFilter: {
                op: "AND",
                filters: [
                  { fieldId: field("kits.requestable"), op: "=", value: true },
                  { fieldId: field("kits.status"), op: "is", value: "available" },
                ],
              },
            },
            {
              kind: "user_input",
              fieldId: field("loans.requested_items"),
              helpText: t.individualItemsHelp,
              relationFilter: {
                op: "AND",
                filters: [
                  { fieldId: field("items.requestable"), op: "=", value: true },
                  { fieldId: field("items.status"), op: "is", value: "available" },
                ],
              },
            },
            {
              kind: "user_input",
              section: { title: t.loanDates },
              fieldId: field("loans.start_date"),
              width: "compact",
              label: t.startDate,
              helpText: t.startDateHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("loans.due_date"),
              width: "compact",
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
              kind: "user_input",
              section: { title: t.contactDetails },
              fieldId: field("loans.requester_name"),
              width: "compact",
              label: t.requesterFormName,
              helpText: t.requesterNameHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("loans.requester_email"),
              width: "compact",
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
              value: ["ready"],
            },
          ],
        },
      },
      {
        key: "edit_loan",
        table: "loans",
        name: t.editLoan,
        config: {
          title: t.editLoan,
          submitLabel: t.saveChanges,
          successMessage: t.changesSaved,
          validations: [
            {
              leftFieldId: field("loans.start_date"),
              operator: "lte",
              rightFieldId: field("loans.due_date"),
              errorFieldId: field("loans.due_date"),
              message: t.dueDateMustFollowStartDate,
            },
          ],
          fields: [
            { kind: "user_input", fieldId: field("loans.start_date"), width: "compact", required: true },
            { kind: "user_input", fieldId: field("loans.due_date"), width: "compact", required: true },
            { kind: "user_input", fieldId: field("loans.availability_confirmed"), helpText: t.availabilityConfirmedDescription },
            { kind: "user_input", fieldId: field("loans.notes") },
          ],
        },
      },
      {
        key: "edit_item",
        table: "items",
        name: t.editItem,
        config: {
          title: t.editItem,
          submitLabel: t.saveChanges,
          successMessage: t.changesSaved,
          fields: [
            { kind: "user_input", fieldId: field("items.name"), required: true },
            { kind: "user_input", fieldId: field("items.location"), width: "compact" },
            { kind: "user_input", fieldId: field("items.serial_no"), width: "compact" },
            { kind: "user_input", fieldId: field("items.requestable"), helpText: t.itemRequestableHelp },
            { kind: "user_input", fieldId: field("items.notes") },
          ],
        },
      },
    ],
    customApps: inventoryApps(t),
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
          table("loan_positions"),
          " as position\nleft join table ",
          table("loans"),
          " as loan on ",
          field("loan_positions.loan"),
          " = loan.id",
          "\nleft join table ",
          table("items"),
          " as item on ",
          field("loan_positions.item"),
          " = item.id",
          "\nselect loan.",
          field("loans.loan_no"),
          " as loan_number",
          ", loan.",
          field("loans.requester_name"),
          " as borrower_name",
          ", loan.",
          field("loans.requester_email"),
          " as borrower_email",
          ", loan.",
          field("loans.organization"),
          " as borrower_organization",
          ", loan.",
          field("loans.start_date"),
          " as loan_start",
          ", loan.",
          field("loans.due_date"),
          " as return_due",
          ", item.",
          field("items.asset_id"),
          " as asset_id, item.",
          field("items.name"),
          " as item_name",
          "\nwhere ",
          field("loan_positions.loan"),
          " = '{{ record.id }}' and ",
          field("loan_positions.status"),
          " != 'cancelled'\nsort ",
          field("loan_positions.position_no"),
          " asc",
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
        key: "complete_repair",
        name: t.completeRepair,
        description: t.completeRepairHelp,
        enabled: true,
        source: `inputs:
  item:
    type: record
    table: ${t.items}
    required: true
steps:
  - atomicRecords:
      locks: [inputs.item]
      checks:
        - table: ${t.items}
          where:
            - { field: ${t.assetId}, op: equals, value: "\${{ inputs.item.${t.assetId} }}" }
            - { field: ${t.status}, op: is, value: maintenance }
            - { field: ${t.currentPosition}, op: isEmpty }
          assert: notEmpty
          message: ${t.positionUnavailable}
      changes:
        - updateRecord:
            record: inputs.item
            set:
              ${t.status}: [available]
              ${t.condition}: [good]
  - succeed:
      message: ${t.repairCompleted}`,
      },
      {
        key: "cancel_position",
        name: t.cancelPosition,
        description: t.cancelPositionHelp,
        enabled: true,
        source: `inputs:
  position:
    type: record
    table: ${t.loanPositions}
    required: true
steps:
  - setVariable:
      name: loan
      value: \${{ inputs.position.${t.positionLoan} }}
  - atomicRecords:
      locks: [inputs.position, loan]
      checks:
        - table: ${t.loanPositions}
          where:
            - { field: ${t.positionNumber}, op: equals, value: "\${{ inputs.position.${t.positionNumber} }}" }
            - { field: ${t.status}, op: is, value: planned }
            - { field: ${t.positionLoan}, op: containsAny, value: ["\${{ loan.recordId }}"] }
          assert: notEmpty
          message: ${t.positionUnavailable}
        - table: ${t.loans}
          where:
            - { field: ${t.loanNumber}, op: equals, value: "\${{ loan.${t.loanNumber} }}" }
            - { field: ${t.status}, op: isAnyOf, value: [requested, approved, active] }
          assert: notEmpty
          message: ${t.positionUnavailable}
      changes:
        - updateRecord:
            record: inputs.position
            set:
              ${t.status}: [cancelled]
  - succeed:
      message: ${t.positionCancelled}`,
      },
      {
        key: "reject_loan",
        name: t.rejectLoan,
        description: t.rejectConfirm,
        enabled: true,
        source: `inputs:
  loan:
    type: record
    table: ${t.loans}
    required: true
  reason:
    type: text
    label: ${t.rejectionReason}
    required: true
steps:
  - atomicRecords:
      locks: [inputs.loan]
      checks:
        - table: ${t.loans}
          where:
            - { field: ${t.loanNumber}, op: equals, value: "\${{ inputs.loan.${t.loanNumber} }}" }
            - { field: ${t.status}, op: isAnyOf, value: [requested, approved] }
            - { field: ${t.agreementSent}, op: isNot, value: processing }
          assert: notEmpty
          message: ${t.positionUnavailable}
      changes:
        - updateRecord:
            record: inputs.loan
            set:
              ${t.status}: [rejected]
              ${t.rejectionReason}: \${{ inputs.reason }}
  - succeed:
      message: ${t.loanRejected}`,
      },
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
  - atomicRecords:
      locks: [inputs.loan]
      checks:
        - table: ${t.loans}
          where:
            - { field: ${t.loanNumber}, op: equals, value: "\${{ inputs.loan.${t.loanNumber} }}" }
            - { field: ${t.status}, op: is, value: requested }
          assert: notEmpty
          message: ${t.onlyRequestedLoanCanBeCancelled}
      changes:
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
  - atomicRecords:
      locks: [inputs.loan]
      checks:
        - table: ${t.loans}
          where:
            - { field: ${t.loanNumber}, op: equals, value: "\${{ inputs.loan.${t.loanNumber} }}" }
            - { field: ${t.status}, op: is, value: requested }
            - { field: ${t.availabilityConfirmed}, op: '=', value: true }
            - { field: ${t.requestedFrom}, op: '=', value: "\${{ inputs.loan.${t.requestedFrom} }}" }
            - { field: ${t.dueDate}, op: onOrAfter, value: "\${{ inputs.loan.${t.requestedFrom} }}" }
          assert: notEmpty
          message: ${t.positionUnavailable}
        - table: ${t.loanPositions}
          where:
            - { field: ${t.positionLoan}, op: containsAny, value: ["\${{ inputs.loan.recordId }}"] }
            - { field: ${t.status}, op: isNot, value: cancelled }
          assert: notEmpty
          message: ${t.outstandingPositions}
      changes:
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
      all:
        - notEquals: ["\${{ inputs.loan.${t.status} }}", [approved]]
        - notEquals: ["\${{ inputs.loan.${t.status} }}", [active]]
    then:
      - fail:
          message: ${t.approveBeforeSendingAgreement}
  - if:
      notEquals:
        - \${{ inputs.loan.${t.agreementSent} }}
        - [ready]
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
  - atomicRecords:
      locks: [inputs.loan]
      checks:
        - table: ${t.loans}
          where:
            - field: ${t.loanNumber}
              op: equals
              value: \${{ inputs.loan.${t.loanNumber} }}
            - field: ${t.agreementSent}
              op: is
              value: ready
            - field: ${t.status}
              op: isAnyOf
              value: [approved, active]
            - field: ${t.availabilityConfirmed}
              op: '='
              value: true
            - field: ${t.requestedFrom}
              op: '='
              value: \${{ inputs.loan.${t.requestedFrom} }}
            - field: ${t.dueDate}
              op: onOrAfter
              value: \${{ inputs.loan.${t.requestedFrom} }}
          assert: notEmpty
          message: ${t.agreementAlreadySent}
        - table: ${t.loanPositions}
          where:
            - { field: ${t.positionLoan}, op: containsAny, value: ["\${{ inputs.loan.recordId }}"] }
            - { field: ${t.status}, op: isNot, value: cancelled }
          assert: notEmpty
          message: ${t.outstandingPositions}
      changes:
        - updateRecord:
            record: inputs.loan
            set:
              ${t.agreementSent}: [processing]
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
        ${t.agreementSent}: [sent]
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
        key: "add_position",
        name: t.addPosition,
        description: t.loanedItemsDescription,
        enabled: true,
        source: `inputs:
  loan:
    type: record
    table: ${t.loans}
    required: true
  item:
    type: record
    table: ${t.items}
    required: true
steps:
  - atomicRecords:
      locks: [inputs.loan, inputs.item]
      checks:
        - table: ${t.loans}
          where:
            - { field: ${t.loanNumber}, op: equals, value: "\${{ inputs.loan.${t.loanNumber} }}" }
            - { field: ${t.status}, op: is, value: requested }
          assert: notEmpty
          message: ${t.positionUnavailable}
        - table: ${t.loanPositions}
          where:
            - { field: ${t.positionLoan}, op: containsAny, value: ["\${{ inputs.loan.recordId }}"] }
            - { field: ${t.positionItem}, op: containsAny, value: ["\${{ inputs.item.recordId }}"] }
            - { field: ${t.status}, op: isNot, value: cancelled }
          assert: empty
          message: ${t.positionUnavailable}
      changes:
        - createRecord:
            table: ${t.loanPositions}
            values:
              ${t.positionLoan}: \${{ inputs.loan.recordId }}
              ${t.positionItem}: \${{ inputs.item.recordId }}
              ${t.status}: [planned]
  - succeed:
      message: ${t.addPosition}`,
      },
      {
        key: "issue_position",
        name: t.issuePosition,
        description: t.positionIssued,
        enabled: true,
        source: `inputs:
  position:
    type: record
    table: ${t.loanPositions}
    required: true
steps:
  - setVariable:
      name: item
      value: \${{ inputs.position.${t.positionItem} }}
  - setVariable:
      name: loan
      value: \${{ inputs.position.${t.positionLoan} }}
  - atomicRecords:
      locks: [inputs.position, item, loan]
      checks:
        - table: ${t.loanPositions}
          where:
            - { field: ${t.positionNumber}, op: equals, value: "\${{ inputs.position.${t.positionNumber} }}" }
            - { field: ${t.status}, op: is, value: planned }
            - { field: ${t.positionItem}, op: containsAny, value: ["\${{ item.recordId }}"] }
            - { field: ${t.positionLoan}, op: containsAny, value: ["\${{ loan.recordId }}"] }
          assert: notEmpty
          message: ${t.positionUnavailable}
        - table: ${t.items}
          where:
            - { field: ${t.assetId}, op: equals, value: "\${{ item.${t.assetId} }}" }
            - { field: ${t.status}, op: is, value: available }
            - { field: ${t.currentPosition}, op: isEmpty }
          assert: notEmpty
          message: ${t.positionUnavailable}
        - table: ${t.loans}
          where:
            - { field: ${t.loanNumber}, op: equals, value: "\${{ loan.${t.loanNumber} }}" }
            - { field: ${t.status}, op: isAnyOf, value: [approved, active] }
          assert: notEmpty
          message: ${t.positionUnavailable}
      changes:
        - updateRecord:
            record: loan
            set:
              ${t.status}: [active]
        - updateRecord:
            record: inputs.position
            set:
              ${t.status}: [issued]
              ${t.issuedAt}: \${{ now() }}
        - updateRecord:
            record: item
            set:
              ${t.status}: [in_use]
              ${t.currentPosition}: \${{ inputs.position.recordId }}
  - succeed:
      message: ${t.positionIssued}`,
      },
      {
        key: "close_loan",
        name: t.closeLoan,
        description: t.outstandingPositions,
        enabled: true,
        source: `inputs:
  loan:
    type: record
    table: ${t.loans}
    required: true
steps:
  - atomicRecords:
      locks: [inputs.loan]
      checks:
        - table: ${t.loans}
          where:
            - { field: ${t.loanNumber}, op: equals, value: "\${{ inputs.loan.${t.loanNumber} }}" }
            - { field: ${t.status}, op: is, value: active }
          assert: notEmpty
          message: ${t.positionUnavailable}
        - table: ${t.loanPositions}
          where:
            - { field: ${t.positionLoan}, op: containsAny, value: ["\${{ inputs.loan.recordId }}"] }
          assert: notEmpty
          message: ${t.outstandingPositions}
        - table: ${t.loanPositions}
          where:
            - { field: ${t.positionLoan}, op: containsAny, value: ["\${{ inputs.loan.recordId }}"] }
            - { field: ${t.status}, op: isAnyOf, value: [planned, issued] }
          assert: empty
          message: ${t.outstandingPositions}
      changes:
        - updateRecord:
            record: inputs.loan
            set:
              ${t.status}: [returned]
              ${t.returnedAt}: \${{ now() }}
  - succeed:
      message: ${t.loanClosed}`,
      },
      {
        key: "return_loan_item",
        name: t.markLoanItemReturned,
        description: t.markLoanItemReturnedDescription,
        source: `inputs:
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
      - "${t.good}"
      - "${t.used}"
      - "${t.needsRepair}"
    required: true
steps:
  - if:
      not:
        exists: inputs.item.${t.currentPosition}
    then:
      - fail:
          message: ${t.noCurrentPosition}
  - setVariable:
      name: position
      value: \${{ inputs.item.${t.currentPosition} }}
  - if:
      equals:
        - \${{ inputs.condition }}
        - "${t.needsRepair}"
    then:
${returnPosition("maintenance", "repair")
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
    else:
      - if:
          equals: ["\${{ inputs.condition }}", "${t.used}"]
        then:
${returnPosition("available", "used")
  .split("\n")
  .map((line) => `          ${line}`)
  .join("\n")}
        else:
${returnPosition("available", "good")
  .split("\n")
  .map((line) => `          ${line}`)
  .join("\n")}
  - succeed:
      message: ${t.positionReturned}`,
        enabled: true,
      },
    ],
    workflowLaunchers: [
      {
        key: "complete_repair",
        workflow: "complete_repair",
        name: t.completeRepair,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "cancel_position",
        workflow: "cancel_position",
        name: t.cancelPosition,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "reject_loan",
        workflow: "reject_loan",
        name: t.rejectLoan,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "return_loan_item_custom_app",
        workflow: "return_loan_item",
        name: t.markLoanItemReturned,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "add_position",
        workflow: "add_position",
        name: t.addPosition,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "issue_position",
        workflow: "issue_position",
        name: t.issuePosition,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      { key: "close_loan", workflow: "close_loan", name: t.closeLoan, config: { kind: "customApp", inputMode: "prompt" }, enabled: true },
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
          inputSources: { ["item"]: { kind: "scan", value: "record", resolve: { by: "field", field: t.assetId } } },
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
