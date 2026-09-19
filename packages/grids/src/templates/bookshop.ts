import { i18n } from "@k2b/stdlib";
import { createMockCover } from "@k2b/cloud/shared";
import { currentMonthDate, documentTemplate, field, form, formula, type GridTemplate, record, table } from "./types";

import { bookshopApp } from "./bookshop-app";
import { bookshopSummary } from "./bookshop-summary";

const bookshopMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      removeLine: "Remove line",
      removeLineConfirm: "Remove this book from the order?",
      removeLineError: "This line cannot be removed because summary delivery has already started.",
      editOrder: "Edit order",

      total: "Total",
      completedOrders: "Delivered orders",
      customerDirectory: "Customer directory",
      workbench: "Orders to fulfill",
      archive: "Completed orders",
      catalog: "Catalog",
      insights: "Sales overview",
      edit: "Edit",
      save: "Save",
      saved: "Saved.",
      addCustomer: "Add customer",
      noOrders: "No orders here. Create an order to start collecting its books.",
      noLines: "No books yet. Add the first book to this order.",
      noCustomers: "No customers yet. Add one here or while creating an order.",
      noBooks: "Your catalog is empty. Add a book to make it available for orders.",
      orderValue: "Order value",
      orderValueHelp: "Sum of captured sale prices. This is not a payment balance.",
      workbenchHelp: "Open an order to add books, check its summary and update fulfillment. New orders remain here until delivered.",
      catalogHelp:
        "Find a title, check availability and maintain its sale price. Availability is a manual flag, not a counted stock balance.",
      customerPageHelp: "Contact details used for orders. Open a customer to update their address and see their orders.",
      reviewInvoice: "Review and send",
      invoiceHelp:
        "Check the books, quantities, agreed prices and customer email. Then mark ready and send the summary. This is not a tax invoice; use the Billing template for invoices.",
      sampleHelp: "Demo email addresses end in .test and cannot receive summaries. Replace the customer email before a real send.",
      invoiceAccepted: "Summary delivery requested. You can continue working; status and the PDF appear here.",
      invoiceConfirm: "Create the order summary and email a private download link to this customer?",
      deliveryHelp:
        "Delivery has started or finished. Inspect the original workflow run before retrying an interrupted delivery; email may already have been sent.",
      salesHelp: "Order values from captured line prices, including open orders. These figures do not track received payments.",
      backOrders: "All orders",
      backCatalog: "Back to catalog",
      backCustomers: "Back to customers",
      backOrder: "Back to order",
      editLine: "Edit order line",
      lineDetails: "Book and agreed price",
      fulfillment: "Fulfillment",
      contact: "Contact",
      optionalDetails: "More details",
      newOrderHelp: "Create the order first, then add its books on the order page.",
      shippingHelp: "Update the status after dispatch or handover. This does not send an email.",
      noLinesInvoice: "Add at least one order line before sending the summary.",
      templateName: "Bookshop",
      templateDescription: "Manage a book catalog, customers, orders, fulfillment, and order summaries.",
      highlightCatalog: "Relational catalog and order tracking",
      highlightSales: "Order values and fulfillment overview",
      highlightInvoices: "Order summaries with explicit email delivery",
      baseDescription: "Inventory and order tracking for a small bookshop.",
      authors: "Authors",
      authorsDescription: "People who wrote the books.",
      name: "Name",
      authorNameDescription: "The author's display name.",
      birthYear: "Birth year",
      birthYearDescription: "The year the author was born.",
      country: "Country",
      countryDescription: "The country most associated with this author.",
      germany: "Germany",
      unitedKingdom: "United Kingdom",
      unitedStates: "United States",
      japan: "Japan",
      bio: "Bio",
      bioDescription: "Short internal notes about the author.",
      genres: "Genres",
      genresDescription: "Reusable genre catalog.",
      genreNameDescription: "The genre name shown on books and filters.",
      description: "Description",
      genreDescriptionDescription: "Optional notes that explain what belongs in this genre.",
      books: "Books",
      booksDescription: "Catalog and inventory.",
      cover: "Cover",
      coverDescription: "Cover image used in card views.",
      title: "Title",
      titleDescription: "The book title shown in catalog and order forms.",
      bookDescriptionDescription: "Catalog notes or a short summary.",
      author: "Author",
      authorDescription: "The author of this book.",
      genre: "Genre",
      genreDescription: "The primary genre for this book.",
      isbnDescription: "International identifier used for book orders and barcode scans.",
      pages: "Pages",
      pagesDescription: "Number of pages in the book.",
      price: "Price",
      priceDescription: "Selling price for one copy.",
      published: "Published",
      publishedDescription: "Original publication date.",
      inStock: "In stock",
      inStockDescription: "Whether the book is currently available for sale.",
      tags: "Tags",
      tagsDescription: "Optional catalog labels for merchandising and filtering.",
      classic: "Classic",
      recommended: "Recommended",
      onSale: "On sale",
      score: "Score",
      scoreDescription: "Internal recommendation score from 0 to 5.",
      skuDescription: "Automatically assigned stock keeping number.",
      authorCountry: "Author country",
      authorCountryDescription: "Lookup from the linked author.",
      customers: "Customers",
      customersDescription: "Bookshop customers.",
      customerNameDescription: "The customer's display name.",
      email: "Email",
      emailDescription: "Contact address used for order summaries.",
      phone: "Phone",
      phoneDescription: "Optional phone number.",
      joined: "Joined",
      joinedDescription: "Date the customer was first added.",
      notes: "Notes",
      notesDescription: "Private customer notes and reading interests.",
      source: "Source",
      sourceDescription: "How this customer first reached the bookshop.",
      website: "Website",
      inStore: "In-store",
      referral: "Referral",
      orders: "Orders",
      ordersDescription: "Customer orders and their fulfillment state.",
      orderNumber: "Order number",
      orderNumberDescription: "Automatically assigned order number.",
      customer: "Customer",
      customerDescription: "Customer who placed the order.",
      orderedAt: "Ordered at",
      orderedAtDescription: "Date the order was placed.",
      status: "Status",
      statusDescription: "Current fulfillment status.",
      statusNew: "New",
      statusShipped: "Shipped",
      statusDelivered: "Delivered",
      readyToInvoice: "Ready to send",
      readyToInvoiceDescription: "Confirm that the books, quantities, prices and customer email have been reviewed.",
      invoiceSent: "Summary delivery",
      invoiceSentDescription:
        "Ready, in progress, or sent. Inspect the original run before resetting an interrupted delivery; it may already have sent email.",
      deliveryReady: "Ready",
      deliveryProcessing: "In progress",
      deliverySent: "Sent",
      customerName: "Customer name",
      customerNameLookupDescription: "Lookup from the linked customer.",
      customerEmail: "Customer email",
      customerEmailDescription: "Email address from the linked customer.",
      orderLines: "Order lines",
      orderLinesDescription: "Books and agreed sale prices captured for each order.",
      lineNumber: "Line number",
      lineNumberDescription: "Generated identifier for this order line.",
      order: "Order",
      orderDescription: "Order this line belongs to.",
      book: "Book",
      bookDescription: "Book sold on this line.",
      quantity: "Quantity",
      quantityDescription: "Number of copies sold.",
      unitPrice: "Unit price",
      unitPriceDescription: "Agreed sale price. Changing the catalog price does not change existing order lines.",
      lineTotal: "Line total",
      lineTotalDescription: "Quantity multiplied by the agreed unit price.",
      bookTitle: "Book title",
      bookTitleDescription: "Lookup from the linked book.",
      tolkienBio: "Philologist; coined Middle-earth.",
      leGuinBio: "SF/F that takes anthropology seriously.",
      christieBio: "Best-selling mystery novelist.",
      fantasy: "Fantasy",
      fantasyDescription: "Worlds, magic, dragons.",
      sciFi: "Sci-Fi",
      sciFiDescription: "Speculative futures, hard tech.",
      mystery: "Mystery",
      mysteryDescription: "Whodunits and noir.",
      hobbitDescription: "A compact fantasy classic.",
      aliceNotes: "Loves fantasy.",
      recentBooks: "Recent books",
      orderCalendar: "Order calendar",
      addBook: "Add book",
      titleHelp: "Book title shown in catalog and order forms.",
      authorHelp: "Pick an existing author or create one inline.",
      authorName: "Author name",
      authorNameHelp: "Full author name.",
      countryHelp: "Optional author country.",
      birthYearHelp: "Optional year of birth.",
      isbnHelp: "Optional ISBN used for ordering and scans.",
      genreHelp: "Pick an existing genre or create one inline.",
      genreName: "Genre name",
      genreNameHelp: "Short catalog genre, for example Fantasy.",
      genreDescriptionHelp: "Optional notes about this genre.",
      pagesHelp: "Number of pages.",
      tagsHelp: "Optional catalog labels.",
      newOrder: "New order",
      createOrder: "Create order",
      orderCreated: "Order created.",
      customerHelp: "Buyer for this order.",
      customerNameHelp: "Full customer name.",
      emailHelp: "Order contact address.",
      orderedAtHelp: "Date the order was placed.",
      addOrderLine: "Add order line",
      addOrderLineDescription: "Add a book and its agreed sale price to this order.",
      addLine: "Add line",
      orderLineAdded: "Order line added.",
      orderHelp: "Order this item belongs to.",
      bookHelp: "Book sold on this line.",
      quantityHelp: "Number of copies.",
      unitPriceHelp: "Agreed price per copy.",
      orderInvoice: "Order summary",
      orderInvoiceDescription: "Snapshot of the books and agreed prices in one order. Not a tax invoice.",
      orderInvoiceReady: "Order summary ready",
      orderInvoiceReadyDescription: "Sends a private link to the order summary.",
      invoiceSubject: "Summary for order {{ data.orderNumber }}",
      invoiceEmailHtml: `<main style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;max-width:640px;margin:0 auto;padding:32px;">
  <h1 style="font-size:24px;margin:0 0 16px;">Your order summary is ready</h1>
  <p>Hello {{ data.customerName | default: "there" }},</p>
  <p>We prepared the order summary for order <strong>{{ data.orderNumber }}</strong>.</p>
  <p style="margin:24px 0;"><a href="{{ data.invoice.url }}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;">Download summary</a></p>
  <p style="color:#6b7280;font-size:14px;">This private link expires in 30 days.</p>
</main>`,
      sendOrderInvoice: "Send order summary",
      sendOrderInvoiceDescription: "Creates an order summary and emails a private download link to the customer.",
      invoiceAlreadySent: "Summary delivery is not ready. Inspect the original workflow run and existing documents before retrying.",
      addCustomerEmail: "Add a customer email address before sending the summary.",
      replaceSampleEmail: "Replace the sample customer email before sending a real order summary.",
      completeOrderLines: "Review the books and agreed prices, then mark the order ready to send.",
      invoiceSentMessage: ({ orderNumber, customerEmail }: { orderNumber: string; customerEmail: string }) =>
        `Order summary ${orderNumber} sent to ${customerEmail}.`,
      chooseOrderToSendInvoice: "Choose order to send summary",
      monthlyRevenue: "Monthly order value",
      sendInvoice: "Send summary",
    },
    de: {
      removeLine: "Position entfernen",
      removeLineConfirm: "Dieses Buch aus der Bestellung entfernen?",
      removeLineError: "Die Position kann nicht entfernt werden, weil der Versand der Übersicht bereits gestartet wurde.",
      editOrder: "Bestellung bearbeiten",

      total: "Summe",
      completedOrders: "Übergebene Bestellungen",
      customerDirectory: "Kundenverzeichnis",
      workbench: "Bestellungen bearbeiten",
      archive: "Abgeschlossene Bestellungen",
      catalog: "Katalog",
      insights: "Verkaufsübersicht",
      edit: "Bearbeiten",
      save: "Speichern",
      saved: "Gespeichert.",
      addCustomer: "Kunde hinzufügen",
      noOrders: "Hier gibt es keine Bestellungen. Erstelle eine Bestellung und füge ihre Bücher hinzu.",
      noLines: "Noch keine Bücher. Füge dieser Bestellung das erste Buch hinzu.",
      noCustomers: "Noch keine Kunden. Lege sie hier oder beim Erstellen einer Bestellung an.",
      noBooks: "Dein Katalog ist leer. Füge ein Buch hinzu, um es in Bestellungen zu verwenden.",
      orderValue: "Bestellwert",
      orderValueHelp: "Summe der vereinbarten Verkaufspreise. Das ist kein Zahlungssaldo.",
      workbenchHelp:
        "Öffne eine Bestellung, um Bücher hinzuzufügen, die Bestellübersicht zu prüfen und den Versand zu aktualisieren. Bis zur Übergabe bleibt sie hier.",
      catalogHelp:
        "Finde Titel, prüfe die Verfügbarkeit und pflege Verkaufspreise. Die Verfügbarkeit wird manuell gepflegt; sie zählt keinen Lagerbestand.",
      customerPageHelp: "Kontaktdaten für Bestellungen. Öffne einen Kunden, um seine Adresse zu ändern und seine Bestellungen zu sehen.",
      reviewInvoice: "Prüfen und versenden",
      invoiceHelp:
        "Prüfe Bücher, Mengen, vereinbarte Preise und Kunden-E-Mail. Markiere die Bestellung dann als bereit und versende die Übersicht. Sie ist keine steuerliche Rechnung; nutze dafür die Rechnungsvorlage.",
      sampleHelp:
        "Demo-Adressen enden auf .test und können keine Bestellübersichten empfangen. Ersetze die Kunden-E-Mail vor einem echten Versand.",
      invoiceAccepted: "Versand der Bestellübersicht beantragt. Du kannst weiterarbeiten; Status und PDF erscheinen hier.",
      invoiceConfirm: "Bestellübersicht erstellen und einen privaten Download-Link an diesen Kunden senden?",
      deliveryHelp:
        "Der Versand wurde gestartet oder abgeschlossen. Prüfe bei einer Unterbrechung zuerst den ursprünglichen Workflow-Lauf; die E-Mail kann bereits versendet worden sein.",
      salesHelp:
        "Bestellwerte aus vereinbarten Positionspreisen, einschließlich offener Bestellungen. Zahlungseingänge werden hier nicht erfasst.",
      backOrders: "Alle Bestellungen",
      backCatalog: "Zurück zum Katalog",
      backCustomers: "Zurück zu Kunden",
      backOrder: "Zurück zur Bestellung",
      editLine: "Position bearbeiten",
      lineDetails: "Buch und vereinbarter Preis",
      fulfillment: "Versand und Übergabe",
      contact: "Kontakt",
      optionalDetails: "Weitere Angaben",
      newOrderHelp: "Erstelle zuerst die Bestellung. Füge ihre Bücher anschließend auf der Bestellseite hinzu.",
      shippingHelp: "Aktualisiere den Status nach Versand oder Übergabe. Dabei wird keine E-Mail versendet.",
      noLinesInvoice: "Füge mindestens eine Position hinzu, bevor du die Bestellübersicht versendest.",
      templateName: "Buchhandlung",
      templateDescription: "Verwalte Buchkatalog, Kunden, Bestellungen, Versand und Bestellübersichten.",
      highlightCatalog: "Verknüpfter Katalog und Bestellverfolgung",
      highlightSales: "Bestellwerte und Versand im Blick",
      highlightInvoices: "Bestellübersichten mit bewusstem E-Mail-Versand",
      baseDescription: "Bestands- und Bestellverwaltung für eine kleine Buchhandlung.",
      authors: "Autoren",
      authorsDescription: "Personen, die die Bücher geschrieben haben.",
      name: "Name",
      authorNameDescription: "Anzeigename des Autors.",
      birthYear: "Geburtsjahr",
      birthYearDescription: "Geburtsjahr des Autors.",
      country: "Land",
      countryDescription: "Land, mit dem der Autor hauptsächlich verbunden ist.",
      germany: "Deutschland",
      unitedKingdom: "Vereinigtes Königreich",
      unitedStates: "Vereinigte Staaten",
      japan: "Japan",
      bio: "Biografie",
      bioDescription: "Kurze interne Notizen über den Autor.",
      genres: "Genres",
      genresDescription: "Wiederverwendbarer Genrekatalog.",
      genreNameDescription: "Name des Genres für Bücher und Filter.",
      description: "Beschreibung",
      genreDescriptionDescription: "Optionale Hinweise dazu, was zu diesem Genre gehört.",
      books: "Bücher",
      booksDescription: "Katalog und Bestand.",
      cover: "Cover",
      coverDescription: "Coverbild für Kartenansichten.",
      title: "Titel",
      titleDescription: "Buchtitel im Katalog und in Bestellformularen.",
      bookDescriptionDescription: "Katalognotizen oder eine kurze Zusammenfassung.",
      author: "Autor",
      authorDescription: "Autor dieses Buches.",
      genre: "Genre",
      genreDescription: "Hauptgenre dieses Buches.",
      isbnDescription: "Internationale Kennung für Buchbestellungen und Barcodescans.",
      pages: "Seiten",
      pagesDescription: "Seitenzahl des Buches.",
      price: "Preis",
      priceDescription: "Verkaufspreis eines Exemplars.",
      published: "Veröffentlichungsdatum",
      publishedDescription: "Datum der Erstveröffentlichung.",
      inStock: "Auf Lager",
      inStockDescription: "Gibt an, ob das Buch derzeit verkauft werden kann.",
      tags: "Schlagwörter",
      tagsDescription: "Optionale Katalogkennzeichnungen für Präsentation und Filter.",
      classic: "Klassiker",
      recommended: "Empfohlen",
      onSale: "Im Angebot",
      score: "Bewertung",
      scoreDescription: "Interne Empfehlung von 0 bis 5.",
      skuDescription: "Automatisch vergebene Artikelnummer.",
      authorCountry: "Land des Autors",
      authorCountryDescription: "Aus dem verknüpften Autor übernommen.",
      customers: "Kunden",
      customersDescription: "Kunden der Buchhandlung.",
      customerNameDescription: "Anzeigename des Kunden.",
      email: "E-Mail-Adresse",
      emailDescription: "Kontaktadresse für Bestellübersichten.",
      phone: "Telefon",
      phoneDescription: "Optionale Telefonnummer.",
      joined: "Hinzugefügt am",
      joinedDescription: "Datum, an dem der Kunde erstmals hinzugefügt wurde.",
      notes: "Notizen",
      notesDescription: "Private Kundennotizen und Leseinteressen.",
      source: "Quelle",
      sourceDescription: "Wie der Kunde erstmals auf die Buchhandlung aufmerksam wurde.",
      website: "Website",
      inStore: "Im Laden",
      referral: "Empfehlung",
      orders: "Bestellungen",
      ordersDescription: "Bestellungen und ihr Versandstatus.",
      orderNumber: "Bestellnummer",
      orderNumberDescription: "Automatisch vergebene Bestellnummer.",
      customer: "Kunde",
      customerDescription: "Kunde, der die Bestellung aufgegeben hat.",
      orderedAt: "Bestelldatum",
      orderedAtDescription: "Datum der Bestellung.",
      status: "Status",
      statusDescription: "Aktueller Versandstatus.",
      statusNew: "Neu",
      statusShipped: "Versendet",
      statusDelivered: "Zugestellt",
      readyToInvoice: "Bereit zum Versenden",
      readyToInvoiceDescription: "Bestätige, dass Bücher, Mengen, Preise und Kunden-E-Mail geprüft sind.",
      invoiceSent: "Versand der Übersicht",
      invoiceSentDescription:
        "Bereit, in Bearbeitung oder gesendet. Prüfe vor dem Zurücksetzen eines unterbrochenen Versands den ursprünglichen Lauf; die E-Mail könnte bereits gesendet worden sein.",
      deliveryReady: "Bereit",
      deliveryProcessing: "In Bearbeitung",
      deliverySent: "Gesendet",
      customerName: "Kundenname",
      customerNameLookupDescription: "Aus dem verknüpften Kunden übernommen.",
      customerEmail: "E-Mail-Adresse des Kunden",
      customerEmailDescription: "E-Mail-Adresse des verknüpften Kunden.",
      orderLines: "Bestellpositionen",
      orderLinesDescription: "Bücher und vereinbarte Verkaufspreise jeder Bestellung.",
      lineNumber: "Positionsnummer",
      lineNumberDescription: "Erzeugte Kennung für diese Bestellposition.",
      order: "Bestellung",
      orderDescription: "Bestellung, zu der diese Position gehört.",
      book: "Buch",
      bookDescription: "In dieser Position verkauftes Buch.",
      quantity: "Menge",
      quantityDescription: "Anzahl der verkauften Exemplare.",
      unitPrice: "Stückpreis",
      unitPriceDescription: "Vereinbarter Verkaufspreis. Spätere Katalogpreisänderungen verändern bestehende Bestellpositionen nicht.",
      lineTotal: "Positionssumme",
      lineTotalDescription: "Menge multipliziert mit dem erfassten Stückpreis.",
      bookTitle: "Buchtitel",
      bookTitleDescription: "Aus dem verknüpften Buch übernommen.",
      tolkienBio: "Philologe; prägte den Begriff Mittelerde.",
      leGuinBio: "Science-Fiction und Fantasy mit ernsthaftem anthropologischem Blick.",
      christieBio: "Erfolgreiche Krimiautorin.",
      fantasy: "Fantasy",
      fantasyDescription: "Welten, Magie und Drachen.",
      sciFi: "Science-Fiction",
      sciFiDescription: "Spekulative Zukunft und anspruchsvolle Technik.",
      mystery: "Krimi",
      mysteryDescription: "Detektivgeschichten und Noir.",
      hobbitDescription: "Ein kompakter Fantasyklassiker.",
      aliceNotes: "Liebt Fantasy.",
      recentBooks: "Zuletzt veröffentlichte Bücher",
      orderCalendar: "Bestellkalender",
      addBook: "Buch hinzufügen",
      titleHelp: "Buchtitel im Katalog und in Bestellformularen.",
      authorHelp: "Wähle einen vorhandenen Autor oder erstelle direkt einen neuen.",
      authorName: "Name des Autors",
      authorNameHelp: "Vollständiger Name des Autors.",
      countryHelp: "Optionales Land des Autors.",
      birthYearHelp: "Optionales Geburtsjahr.",
      isbnHelp: "Optionale ISBN für Bestellungen und Scans.",
      genreHelp: "Wähle ein vorhandenes Genre oder erstelle direkt ein neues.",
      genreName: "Name des Genres",
      genreNameHelp: "Kurzes Kataloggenre, zum Beispiel Fantasy.",
      genreDescriptionHelp: "Optionale Hinweise zu diesem Genre.",
      pagesHelp: "Anzahl der Seiten.",
      tagsHelp: "Optionale Katalogkennzeichnungen.",
      newOrder: "Neue Bestellung",
      createOrder: "Bestellung erstellen",
      orderCreated: "Bestellung erstellt.",
      customerHelp: "Kunde für diese Bestellung.",
      customerNameHelp: "Vollständiger Name des Kunden.",
      emailHelp: "Kontaktadresse für die Bestellung.",
      orderedAtHelp: "Datum der Bestellung.",
      addOrderLine: "Bestellposition hinzufügen",
      addOrderLineDescription: "Füge dieser Bestellung ein Buch mit seinem vereinbarten Verkaufspreis hinzu.",
      addLine: "Position hinzufügen",
      orderLineAdded: "Bestellposition hinzugefügt.",
      orderHelp: "Bestellung, zu der diese Position gehört.",
      bookHelp: "In dieser Position verkauftes Buch.",
      quantityHelp: "Anzahl der Exemplare.",
      unitPriceHelp: "Vereinbarter Preis pro Exemplar.",
      orderInvoice: "Bestellübersicht",
      orderInvoiceDescription: "Momentaufnahme der Bücher und vereinbarten Preise einer Bestellung. Keine steuerliche Rechnung.",
      orderInvoiceReady: "Bestellübersicht fertig",
      orderInvoiceReadyDescription: "Versendet einen privaten Link zur Bestellübersicht.",
      invoiceSubject: "Übersicht zur Bestellung {{ data.orderNumber }}",
      invoiceEmailHtml: `<main style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;max-width:640px;margin:0 auto;padding:32px;">
  <h1 style="font-size:24px;margin:0 0 16px;">Deine Bestellübersicht ist verfügbar</h1>
  <p>Hallo {{ data.customerName | default: "zusammen" }},</p>
  <p>Wir haben die Übersicht für die Bestellung <strong>{{ data.orderNumber }}</strong> erstellt.</p>
  <p style="margin:24px 0;"><a href="{{ data.invoice.url }}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;">Bestellübersicht herunterladen</a></p>
  <p style="color:#6b7280;font-size:14px;">Dieser private Link läuft in 30 Tagen ab.</p>
</main>`,
      sendOrderInvoice: "Bestellübersicht senden",
      sendOrderInvoiceDescription: "Erstellt eine Bestellübersicht und sendet einen privaten Download-Link an den Kunden.",
      invoiceAlreadySent:
        "Der Versand ist nicht bereit. Prüfe vor einem erneuten Versuch den ursprünglichen Workflow-Lauf und die vorhandenen Dokumente.",
      addCustomerEmail: "Ergänze vor dem Versand die E-Mail-Adresse des Kunden.",
      replaceSampleEmail: "Ersetze vor einem echten Versand die Demo-E-Mail-Adresse des Kunden.",
      completeOrderLines: "Prüfe Bücher und vereinbarte Preise und markiere die Bestellung dann als bereit zum Versenden.",
      invoiceSentMessage: ({ orderNumber, customerEmail }) => `Bestellübersicht ${orderNumber} an ${customerEmail} gesendet.`,
      chooseOrderToSendInvoice: "Bestellung für den Versand auswählen",
      monthlyRevenue: "Bestellwert pro Monat",
      sendInvoice: "Übersicht senden",
    },
  },
});

export type BookshopText = ReturnType<typeof bookshopMessages.resolve>["t"];

export const createBookshopTemplate = (locale?: string): GridTemplate => {
  const { t } = bookshopMessages.resolve(locale ? [locale] : []);

  return {
    id: "bookshop",
    name: t.templateName,
    description: t.templateDescription,
    highlights: [t.highlightCatalog, t.highlightSales, t.highlightInvoices],
    icon: "ti ti-books",
    baseName: t.templateName,
    baseDescription: t.baseDescription,
    navigationGroups: [
      {
        name: t.orders,
        entries: [
          { type: "customApp", key: "sales" },
          { type: "table", key: "orders" },
          { type: "form", key: "new_order" },
          { type: "form", key: "add_order_line" },
          { type: "workflow", key: "send_order_invoice" },
          { type: "documentTemplate", key: "order_invoice" },
        ],
      },
      {
        name: t.books,
        entries: [
          { type: "view", key: "recent_books" },
          { type: "form", key: "add_book" },
          { type: "table", key: "authors" },
        ],
      },
    ],
    tables: [
      {
        key: "authors",
        name: t.authors,
        description: t.authorsDescription,
        fields: [
          {
            key: "name",
            name: t.name,
            description: t.authorNameDescription,
            type: "text",
            config: { maxLength: 200 },
            required: true,
            presentable: true,
            icon: "ti ti-user",
          },
          {
            key: "birth_year",
            name: t.birthYear,
            description: t.birthYearDescription,
            type: "number",
            config: { min: 1000, max: 3000, integerOnly: true },
            icon: "ti ti-calendar",
          },
          {
            key: "country",
            name: t.country,
            description: t.countryDescription,
            type: "select",
            icon: "ti ti-map-pin",
            config: {
              options: [
                { id: "de", label: t.germany, color: "#ef4444" },
                { id: "uk", label: t.unitedKingdom, color: "#3b82f6" },
                { id: "us", label: t.unitedStates, color: "#10b981" },
                { id: "jp", label: t.japan, color: "#f59e0b" },
              ],
            },
          },
          {
            key: "bio",
            name: t.bio,
            description: t.bioDescription,
            type: "longtext",
            icon: "ti ti-notes",
          },
        ],
      },
      {
        key: "genres",
        name: t.genres,
        description: t.genresDescription,
        fields: [
          {
            key: "name",
            name: t.name,
            description: t.genreNameDescription,
            type: "text",
            config: { maxLength: 80 },
            required: true,
            presentable: true,
            icon: "ti ti-tag",
          },
          {
            key: "description",
            name: t.description,
            description: t.genreDescriptionDescription,
            type: "longtext",
            icon: "ti ti-align-left",
          },
        ],
      },
      {
        key: "books",
        name: t.books,
        description: t.booksDescription,
        displayConfig: {
          mode: "cards",
          cards: {
            imageFieldId: field("books.cover"),
            fieldIds: [field("books.title"), field("books.author"), field("books.genre"), field("books.price"), field("books.in_stock")],
          },
        },
        fields: [
          {
            key: "cover",
            name: t.cover,
            description: t.coverDescription,
            type: "file",
            config: { maxFiles: 1, accept: ["image/*"] },
            hideInTable: true,
            icon: "ti ti-photo",
          },
          {
            key: "title",
            name: t.title,
            description: t.titleDescription,
            type: "text",
            config: { maxLength: 200 },
            required: true,
            presentable: true,
            icon: "ti ti-book",
          },
          {
            key: "description",
            name: t.description,
            description: t.bookDescriptionDescription,
            type: "longtext",
            icon: "ti ti-align-left",
          },
          {
            key: "author",
            name: t.author,
            description: t.authorDescription,
            type: "relation",
            required: true,
            icon: "ti ti-user",
            config: { targetTableId: table("authors"), cardinality: "single" },
          },
          {
            key: "genre",
            name: t.genre,
            description: t.genreDescription,
            type: "relation",
            required: true,
            icon: "ti ti-tags",
            config: { targetTableId: table("genres"), cardinality: "single" },
          },
          {
            key: "isbn",
            name: "ISBN",
            description: t.isbnDescription,
            type: "text",
            config: { regex: "^97[89]-[0-9]-[0-9]{2,5}-[0-9]{3,7}-[0-9X]$" },
            icon: "ti ti-barcode",
          },
          {
            key: "pages",
            name: t.pages,
            description: t.pagesDescription,
            type: "number",
            config: { min: 1, integerOnly: true },
            icon: "ti ti-file-text",
          },
          {
            key: "price",
            name: t.price,
            description: t.priceDescription,
            type: "number",
            required: true,
            icon: "ti ti-currency-euro",
            config: {
              precision: 16,
              decimalPlaces: 2,
              min: "0",
              unit: "EUR",
              unitPosition: "suffix",
            },
          },
          {
            key: "published",
            name: t.published,
            description: t.publishedDescription,
            type: "date",
            icon: "ti ti-calendar",
          },
          {
            key: "in_stock",
            name: t.inStock,
            description: t.inStockDescription,
            type: "boolean",
            defaultValue: true,
            icon: "ti ti-package",
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
                { id: "classic", label: t.classic, color: "#f59e0b" },
                { id: "recommended", label: t.recommended, color: "#22c55e" },
                { id: "sale", label: t.onSale, color: "#ef4444" },
              ],
            },
          },
          {
            key: "score",
            name: t.score,
            description: t.scoreDescription,
            type: "number",
            config: { min: 0, max: 5, integerOnly: true },
            icon: "ti ti-star",
          },
          {
            key: "sku",
            name: "SKU",
            description: t.skuDescription,
            type: "id",
            config: { strategy: "sequence", prefix: "SKU-", padding: 5 },
            icon: "ti ti-barcode",
          },
          {
            key: "author_country",
            name: t.authorCountry,
            description: t.authorCountryDescription,
            type: "lookup",
            config: {
              relationFieldId: field("books.author"),
              targetFieldId: field("authors.country"),
            },
            icon: "ti ti-hierarchy",
          },
        ],
      },
      {
        key: "customers",
        name: t.customers,
        description: t.customersDescription,
        fields: [
          {
            key: "name",
            name: t.name,
            description: t.customerNameDescription,
            type: "text",
            config: { maxLength: 200 },
            required: true,
            presentable: true,
            icon: "ti ti-user",
          },
          {
            key: "email",
            name: t.email,
            description: t.emailDescription,
            type: "text",
            config: { regex: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" },
            required: true,
            icon: "ti ti-mail",
          },
          {
            key: "phone",
            name: t.phone,
            description: t.phoneDescription,
            type: "text",
            config: { maxLength: 40 },
            icon: "ti ti-phone",
          },
          {
            key: "joined",
            name: t.joined,
            description: t.joinedDescription,
            type: "date",
            icon: "ti ti-calendar-plus",
          },
          {
            key: "notes",
            name: t.notes,
            description: t.notesDescription,
            type: "longtext",
            icon: "ti ti-notes",
          },
          {
            key: "source",
            name: t.source,
            description: t.sourceDescription,
            type: "select",
            icon: "ti ti-route",
            config: {
              options: [
                { id: "website", label: t.website, color: "#3b82f6" },
                { id: "store", label: t.inStore, color: "#22c55e" },
                { id: "referral", label: t.referral, color: "#a855f7" },
              ],
            },
          },
        ],
      },
      {
        key: "orders",
        name: t.orders,
        description: t.ordersDescription,
        fields: [
          {
            key: "order_no",
            name: t.orderNumber,
            description: t.orderNumberDescription,
            type: "id",
            config: {
              strategy: "date_sequence",
              prefix: "ORD-",
              period: "year",
              padding: 4,
            },
            presentable: true,
            icon: "ti ti-hash",
          },
          {
            key: "customer",
            name: t.customer,
            description: t.customerDescription,
            type: "relation",
            required: true,
            icon: "ti ti-user",
            config: { targetTableId: table("customers"), cardinality: "single" },
          },
          {
            key: "ordered_at",
            name: t.orderedAt,
            description: t.orderedAtDescription,
            type: "date",
            required: true,
            icon: "ti ti-calendar",
          },
          {
            key: "status",
            name: t.status,
            description: t.statusDescription,
            type: "select",
            icon: "ti ti-truck-delivery",
            config: {
              options: [
                { id: "new", label: t.statusNew, color: "#3b82f6" },
                { id: "shipped", label: t.statusShipped, color: "#f59e0b" },
                { id: "delivered", label: t.statusDelivered, color: "#22c55e" },
              ],
            },
            required: true,
            defaultValue: ["new"],
          },
          {
            key: "invoice_ready",
            name: t.readyToInvoice,
            description: t.readyToInvoiceDescription,
            type: "boolean",
            defaultValue: false,
            icon: "ti ti-file-check",
          },
          {
            key: "invoice_sent",
            name: t.invoiceSent,
            description: t.invoiceSentDescription,
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
            key: "customer_name",
            name: t.customerName,
            description: t.customerNameLookupDescription,
            type: "lookup",
            config: {
              relationFieldId: field("orders.customer"),
              targetFieldId: field("customers.name"),
            },
            icon: "ti ti-hierarchy",
          },
          {
            key: "customer_email",
            name: t.customerEmail,
            description: t.customerEmailDescription,
            type: "lookup",
            config: {
              relationFieldId: field("orders.customer"),
              targetFieldId: field("customers.email"),
            },
            icon: "ti ti-mail",
          },
        ],
      },
      {
        key: "order_lines",
        name: t.orderLines,
        description: t.orderLinesDescription,
        fields: [
          {
            key: "line_no",
            name: t.lineNumber,
            description: t.lineNumberDescription,
            type: "id",
            config: { strategy: "sequence", prefix: "LINE-", padding: 5 },
            presentable: true,
            icon: "ti ti-list-numbers",
          },
          {
            key: "order",
            name: t.order,
            description: t.orderDescription,
            type: "relation",
            required: true,
            icon: "ti ti-shopping-cart",
            config: { targetTableId: table("orders"), cardinality: "single" },
          },
          {
            key: "book",
            name: t.book,
            description: t.bookDescription,
            type: "relation",
            required: true,
            icon: "ti ti-book",
            config: { targetTableId: table("books"), cardinality: "single" },
          },
          {
            key: "quantity",
            name: t.quantity,
            description: t.quantityDescription,
            type: "number",
            required: true,
            defaultValue: "1",
            config: { min: 1, integerOnly: true },
            icon: "ti ti-calculator",
          },
          {
            key: "unit_price",
            name: t.unitPrice,
            description: t.unitPriceDescription,
            type: "number",
            required: true,
            icon: "ti ti-currency-euro",
            config: {
              precision: 16,
              decimalPlaces: 2,
              min: "0",
              unit: "EUR",
              unitPosition: "suffix",
            },
          },
          {
            key: "line_total",
            name: t.lineTotal,
            description: t.lineTotalDescription,
            type: "formula",
            config: {
              expression: formula(field("order_lines.quantity"), " * ", field("order_lines.unit_price")),
              format: { kind: "decimal", precision: 2, thousandsSeparator: true },
            },
            icon: "ti ti-calculator",
          },
          {
            key: "book_title",
            name: t.bookTitle,
            description: t.bookTitleDescription,
            type: "lookup",
            config: {
              relationFieldId: field("order_lines.book"),
              targetFieldId: field("books.title"),
            },
            icon: "ti ti-hierarchy",
          },
        ],
      },
    ],
    records: [
      {
        key: "authors.tolkien",
        table: "authors",
        values: {
          name: "J.R.R. Tolkien",
          birth_year: 1892,
          country: ["uk"],
          bio: t.tolkienBio,
        },
      },
      {
        key: "authors.le_guin",
        table: "authors",
        values: {
          name: "Ursula K. Le Guin",
          birth_year: 1929,
          country: ["us"],
          bio: t.leGuinBio,
        },
      },
      {
        key: "authors.christie",
        table: "authors",
        values: {
          name: "Agatha Christie",
          birth_year: 1890,
          country: ["uk"],
          bio: t.christieBio,
        },
      },
      {
        key: "genres.fantasy",
        table: "genres",
        values: { name: t.fantasy, description: t.fantasyDescription },
      },
      {
        key: "genres.scifi",
        table: "genres",
        values: {
          name: t.sciFi,
          description: t.sciFiDescription,
        },
      },
      {
        key: "genres.mystery",
        table: "genres",
        values: { name: t.mystery, description: t.mysteryDescription },
      },
      {
        key: "books.hobbit",
        table: "books",
        values: {
          title: "The Hobbit",
          description: t.hobbitDescription,
          author: [record("authors.tolkien")],
          genre: [record("genres.fantasy")],
          isbn: "978-0-547-92822-7",
          pages: 310,
          price: "9.99",
          published: "1937-09-21",
          in_stock: true,
          tags: ["classic", "recommended"],
          score: 5,
        },
        files: [
          {
            field: "cover",
            filename: "the-hobbit-cover.svg",
            dataUrl: createMockCover({
              icon: "book",
              theme: "emerald",
              seed: "bookshop:the-hobbit",
              label: "The Hobbit",
            }).dataUrl,
          },
        ],
      },
      {
        key: "books.left_hand",
        table: "books",
        values: {
          title: "The Left Hand of Darkness",
          author: [record("authors.le_guin")],
          genre: [record("genres.scifi")],
          isbn: "978-0-441-47812-5",
          pages: 304,
          price: "11.99",
          published: "1969-03-01",
          in_stock: true,
          tags: ["recommended"],
          score: 5,
        },
        files: [
          {
            field: "cover",
            filename: "left-hand-of-darkness-cover.svg",
            dataUrl: createMockCover({
              icon: "book",
              theme: "violet",
              seed: "bookshop:left-hand",
              label: "The Left Hand of Darkness",
            }).dataUrl,
          },
        ],
      },
      {
        key: "books.abc",
        table: "books",
        values: {
          title: "The ABC Murders",
          author: [record("authors.christie")],
          genre: [record("genres.mystery")],
          isbn: "978-0-00-752752-6",
          pages: 220,
          price: "8.50",
          published: "1936-01-06",
          in_stock: false,
          tags: [],
          score: 4,
        },
        files: [
          {
            field: "cover",
            filename: "abc-murders-cover.svg",
            dataUrl: createMockCover({
              icon: "book",
              theme: "amber",
              seed: "bookshop:abc",
              label: "The ABC Murders",
            }).dataUrl,
          },
        ],
      },
      {
        key: "customers.alice",
        table: "customers",
        values: {
          name: "Alice Becker",
          email: "alice@example.test",
          phone: "+49 731 1234567",
          joined: "2025-03-12",
          notes: t.aliceNotes,
          source: ["website"],
        },
      },
      {
        key: "customers.bob",
        table: "customers",
        values: {
          name: "Bob Schmidt",
          email: "bob@example.test",
          phone: "+49 731 7654321",
          joined: "2025-06-04",
          source: ["store"],
        },
      },
      {
        key: "orders.1",
        table: "orders",
        values: {
          customer: [record("customers.alice")],
          ordered_at: currentMonthDate(3),
          status: ["delivered"],
          invoice_ready: false,
          invoice_sent: ["sent"],
        },
      },
      {
        key: "orders.2",
        table: "orders",
        values: {
          customer: [record("customers.bob")],
          ordered_at: currentMonthDate(8),
          status: ["shipped"],
          invoice_ready: false,
          invoice_sent: ["sent"],
        },
      },
      {
        key: "orders.3",
        table: "orders",
        values: {
          customer: [record("customers.alice")],
          ordered_at: currentMonthDate(13),
          status: ["new"],
          invoice_ready: true,
          invoice_sent: ["ready"],
        },
      },
      {
        key: "order_lines.1_hobbit",
        table: "order_lines",
        values: {
          order: [record("orders.1")],
          book: [record("books.hobbit")],
          quantity: "2",
          unit_price: "9.99",
        },
      },
      {
        key: "order_lines.1_left_hand",
        table: "order_lines",
        values: {
          order: [record("orders.1")],
          book: [record("books.left_hand")],
          quantity: "1",
          unit_price: "11.99",
        },
      },
      {
        key: "order_lines.2_abc",
        table: "order_lines",
        values: {
          order: [record("orders.2")],
          book: [record("books.abc")],
          quantity: "1",
          unit_price: "8.50",
        },
      },
      {
        key: "order_lines.3_hobbit",
        table: "order_lines",
        values: {
          order: [record("orders.3")],
          book: [record("books.hobbit")],
          quantity: "1",
          unit_price: "9.99",
        },
      },
      {
        key: "order_lines.3_left_hand",
        table: "order_lines",
        values: {
          order: [record("orders.3")],
          book: [record("books.left_hand")],
          quantity: "3",
          unit_price: "11.99",
        },
      },
    ],
    views: [
      {
        key: "recent_books",
        table: "books",
        name: t.recentBooks,
        shared: true,
        source: formula(
          "from table ",
          table("books"),
          "\nselect ",
          field("books.title"),
          ", ",
          field("books.isbn"),
          ", ",
          field("books.author"),
          ", ",
          field("books.price"),
          ", ",
          field("books.published"),
          "\nsort ",
          field("books.published"),
          " desc\nlimit 20",
        ),
        ui: {
          columns: [
            { fieldId: field("books.title") },
            {
              fieldId: field("books.isbn"),
              format: { kind: "barcode", bcid: "isbn", showText: true },
            },
            { fieldId: field("books.author") },
            { fieldId: field("books.price") },
            { fieldId: field("books.published") },
          ],
          displayConfig: {
            mode: "cards",
            cards: {
              imageFieldId: field("books.cover"),
              fieldIds: [field("books.title"), field("books.author"), field("books.genre"), field("books.price"), field("books.published")],
            },
          },
        },
      },
      {
        key: "order_calendar",
        table: "orders",
        name: t.orderCalendar,
        shared: true,
        source: formula(
          "from table ",
          table("orders"),
          "\nselect ",
          field("orders.order_no"),
          ", ",
          field("orders.ordered_at"),
          ", ",
          field("orders.customer"),
          ", ",
          field("orders.status"),
          ", ",
          field("orders.invoice_ready"),
          ", ",
          field("orders.invoice_sent"),
          "\nsort ",
          field("orders.ordered_at"),
          " desc",
        ),
        ui: {
          columns: [
            { fieldId: field("orders.order_no") },
            { fieldId: field("orders.ordered_at") },
            { fieldId: field("orders.customer") },
            { fieldId: field("orders.status") },
            { fieldId: field("orders.invoice_ready") },
            { fieldId: field("orders.invoice_sent") },
          ],
          displayConfig: {
            mode: "calendar",
            calendar: { dateFieldId: field("orders.ordered_at") },
          },
        },
      },
    ],
    forms: [
      {
        key: "edit_order",
        table: "orders",
        name: t.editOrder,
        config: {
          title: t.editOrder,
          submitLabel: t.save,
          successMessage: t.saved,
          fields: [
            { kind: "user_input", fieldId: field("orders.customer"), label: t.customer, helpText: t.customerHelp, required: true },
            { kind: "user_input", fieldId: field("orders.ordered_at"), label: t.orderedAt, helpText: t.orderedAtHelp, required: true },
          ],
        },
      },
      {
        key: "customer",
        table: "customers",
        name: t.customers,
        config: {
          title: t.contact,
          submitLabel: t.save,
          successMessage: t.saved,
          fields: [
            { kind: "user_input", fieldId: field("customers.name"), label: t.name, required: true, helpText: t.customerNameHelp },
            { kind: "user_input", fieldId: field("customers.email"), label: t.email, required: true, helpText: t.emailHelp },
            { kind: "user_input", fieldId: field("customers.phone"), label: t.phone, helpText: t.phoneDescription },
            {
              kind: "user_input",
              fieldId: field("customers.source"),
              label: t.source,
              helpText: t.sourceDescription,
              section: { title: t.optionalDetails, collapsible: true },
            },
            { kind: "user_input", fieldId: field("customers.notes"), label: t.notes, helpText: t.notesDescription },
          ],
        },
      },
      {
        key: "edit_order_line",
        table: "order_lines",
        name: t.editLine,
        config: {
          title: t.lineDetails,
          submitLabel: t.save,
          successMessage: t.saved,
          fields: [
            { kind: "user_input", fieldId: field("order_lines.book"), label: t.book, required: true, helpText: t.bookHelp },
            {
              kind: "user_input",
              fieldId: field("order_lines.quantity"),
              label: t.quantity,
              required: true,
              width: "compact",
              helpText: t.quantityHelp,
            },
            {
              kind: "user_input",
              fieldId: field("order_lines.unit_price"),
              label: t.unitPrice,
              required: true,
              width: "compact",
              helpText: t.unitPriceHelp,
            },
          ],
        },
      },
      {
        key: "add_book",
        table: "books",
        name: t.addBook,
        config: {
          title: t.book,
          submitLabel: t.save,
          successMessage: t.saved,
          fields: [
            {
              kind: "user_input",
              fieldId: field("books.title"),
              label: t.title,
              helpText: t.titleHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("books.author"),
              label: t.author,
              helpText: t.authorHelp,
              required: true,
              inlineCreate: {
                enabled: true,
                fields: [
                  {
                    fieldId: field("authors.name"),
                    label: t.authorName,
                    helpText: t.authorNameHelp,
                    required: true,
                  },
                  {
                    fieldId: field("authors.country"),
                    label: t.country,
                    helpText: t.countryHelp,
                  },
                  {
                    fieldId: field("authors.birth_year"),
                    label: t.birthYear,
                    helpText: t.birthYearHelp,
                  },
                ],
              },
            },
            {
              kind: "user_input",
              fieldId: field("books.isbn"),
              label: "ISBN",
              helpText: t.isbnHelp,
            },
            {
              kind: "user_input",
              fieldId: field("books.genre"),
              label: t.genre,
              helpText: t.genreHelp,
              required: true,
              inlineCreate: {
                enabled: true,
                fields: [
                  {
                    fieldId: field("genres.name"),
                    label: t.genreName,
                    helpText: t.genreNameHelp,
                    required: true,
                  },
                  {
                    fieldId: field("genres.description"),
                    label: t.description,
                    helpText: t.genreDescriptionHelp,
                  },
                ],
              },
            },
            {
              kind: "user_input",
              fieldId: field("books.price"),
              label: t.price,
              helpText: t.priceDescription,
              required: true,
            },
            { kind: "user_input", fieldId: field("books.in_stock"), label: t.inStock, helpText: t.inStockDescription },
            {
              kind: "user_input",
              fieldId: field("books.pages"),
              section: { title: t.optionalDetails, collapsible: true },
              label: t.pages,
              helpText: t.pagesHelp,
            },
            {
              kind: "user_input",
              fieldId: field("books.published"),
              label: t.published,
              helpText: t.publishedDescription,
            },
            {
              kind: "user_input",
              fieldId: field("books.tags"),
              label: t.tags,
              helpText: t.tagsHelp,
            },
            {
              kind: "user_input",
              fieldId: field("books.score"),
              label: t.score,
              helpText: t.scoreDescription,
            },
            {
              kind: "user_input",
              fieldId: field("books.description"),
              label: t.description,
              helpText: t.bookDescriptionDescription,
            },
          ],
        },
      },
      {
        key: "new_order",
        table: "orders",
        name: t.newOrder,
        config: {
          title: t.newOrder,
          description: t.newOrderHelp,
          submitLabel: t.createOrder,
          successMessage: t.orderCreated,
          fields: [
            {
              kind: "user_input",
              fieldId: field("orders.customer"),
              label: t.customer,
              helpText: t.customerHelp,
              required: true,
              inlineCreate: {
                enabled: true,
                fields: [
                  {
                    fieldId: field("customers.name"),
                    label: t.customerName,
                    helpText: t.customerNameHelp,
                    required: true,
                  },
                  {
                    fieldId: field("customers.email"),
                    label: t.email,
                    helpText: t.emailHelp,
                    required: true,
                  },
                  {
                    fieldId: field("customers.phone"),
                    label: t.phone,
                    helpText: t.phoneDescription,
                  },
                ],
              },
            },
            {
              kind: "user_input",
              fieldId: field("orders.ordered_at"),
              defaultValue: { kind: "now" },
              label: t.orderedAt,
              helpText: t.orderedAtHelp,
              required: true,
            },
            {
              kind: "form_value",
              fieldId: field("orders.status"),
              value: ["new"],
            },
            {
              kind: "form_value",
              fieldId: field("orders.invoice_ready"),
              value: false,
            },
            {
              kind: "form_value",
              fieldId: field("orders.invoice_sent"),
              value: ["ready"],
            },
          ],
        },
      },
      {
        key: "add_order_line",
        table: "order_lines",
        name: t.addOrderLine,
        config: {
          title: t.addOrderLine,
          description: t.addOrderLineDescription,
          submitLabel: t.addLine,
          successMessage: t.orderLineAdded,
          fields: [
            {
              kind: "user_input",
              fieldId: field("order_lines.order"),
              label: t.order,
              helpText: t.orderHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("order_lines.book"),
              label: t.book,
              helpText: t.bookHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("order_lines.quantity"),
              label: t.quantity,
              width: "compact",
              helpText: t.quantityHelp,
              required: true,
              defaultValue: "1",
            },
            {
              kind: "user_input",
              fieldId: field("order_lines.unit_price"),
              label: t.unitPrice,
              width: "compact",
              helpText: t.unitPriceHelp,
              required: true,
            },
          ],
        },
      },
    ],
    documentTemplates: [
      {
        key: "order_invoice",
        table: "orders",
        renderer: bookshopSummary(t),
        name: t.orderInvoice,
        description: t.orderInvoiceDescription,
        source: formula(
          "from table ",
          table("order_lines"),
          " as line\njoin table ",
          table("orders"),
          " as order on line.",
          field("order_lines.order"),
          " = order.id",
          "\nselect ",
          "order.",
          field("orders.order_no"),
          " as invoice_number, ",
          "order.",
          field("orders.customer_name"),
          " as recipient_name, ",
          "order.",
          field("orders.customer_email"),
          " as recipient_email, ",
          "line.",
          field("order_lines.book_title"),
          " as invoice_item, ",
          "line.",
          field("order_lines.quantity"),
          " as invoice_quantity, ",
          "line.",
          field("order_lines.unit_price"),
          " as invoice_unit_price, ",
          "line.",
          field("order_lines.line_total"),
          " as invoice_line_total, ",
          "order.",
          field("orders.ordered_at"),
          " as invoice_date, ",
          "order.",
          field("orders.status"),
          "\nwhere ",
          field("order_lines.order"),
          " = '{{ record.id }}'\nsort line.",
          field("order_lines.line_no"),
          " asc",
        ),
        enabled: true,
      },
    ],
    emailTemplates: [
      {
        key: "order_invoice_ready",
        name: t.orderInvoiceReady,
        description: t.orderInvoiceReadyDescription,
        subject: t.invoiceSubject,
        html: t.invoiceEmailHtml,
        sampleData: {
          customerName: "Ada Lovelace",
          orderNumber: "ORD-2026-0042",
          invoice: {
            url: "https://cloud.example.org/share/grids/documents/example",
          },
        },
        enabled: true,
      },
    ],
    workflows: [
      {
        key: "remove_order_line",
        name: t.removeLine,
        enabled: true,
        source: `inputs:
  line: {type: record, table: ${JSON.stringify(t.orderLines)}, required: true}
steps:
  - atomicRecords:
      locks: [inputs.line, inputs.line.${t.order}]
      checks:
        - query:
            source: |
              from table ${JSON.stringify(t.orderLines)} as line
              join table ${JSON.stringify(t.orders)} as parent on line.${JSON.stringify(t.order)} = parent.id
              select line.${JSON.stringify(t.lineNumber)}
              where record.id = @params.line and ${JSON.stringify(t.order)} = @params.order and parent.${JSON.stringify(t.invoiceSent)} = 'ready'
              limit 1
            parameters:
              line: {type: record, value: "\${{ inputs.line }}"}
              order: {type: record, value: "\${{ inputs.line.${t.order} }}"}
          assert: notEmpty
          message: ${JSON.stringify(t.removeLineError)}
      changes:
        - deleteRecord: {record: inputs.line}
`,
      },
      {
        key: "send_order_invoice",
        name: t.sendOrderInvoice,
        description: t.sendOrderInvoiceDescription,
        source: `inputs:
  order:
    type: record
    table: ${t.orders}
    label: ${t.order}
    required: true
steps:
  - if:
      notEquals:
        - \${{ inputs.order.${t.invoiceSent} }}
        - [ready]
    then:
      - fail:
          message: ${t.invoiceAlreadySent}
  - if:
      not:
        exists: inputs.order.${t.customerEmail}
    then:
      - fail:
          message: ${t.addCustomerEmail}
  - if:
      endsWith:
        - \${{ inputs.order.${t.customerEmail} }}
        - .test
    then:
      - fail:
          message: ${t.replaceSampleEmail}
  - if:
      notEquals:
        - \${{ inputs.order.${t.readyToInvoice} }}
        - true
    then:
      - fail:
          message: ${t.completeOrderLines}
  - atomicRecords:
      locks: [inputs.order]
      checks:
        - table: ${t.orders}
          where:
            - field: ${t.orderNumber}
              op: equals
              value: \${{ inputs.order.${t.orderNumber} }}
            - field: ${t.invoiceSent}
              op: is
              value: ready
            - field: ${t.readyToInvoice}
              op: '='
              value: true
          assert: notEmpty
          message: ${t.invoiceAlreadySent}
        - query:
            source: |
              from table ${JSON.stringify(t.orderLines)}
              where ${JSON.stringify(t.order)} = @params.order
              limit 1
            parameters:
              order: {type: record, value: "\${{ inputs.order }}"}
          assert: notEmpty
          message: ${t.noLinesInvoice}
      changes:
        - updateRecord:
            record: inputs.order
            set:
              ${t.invoiceSent}: [processing]
  - generateDocument:
      template: ${t.orderInvoice}
      record: inputs.order
      saveAs: invoicePdf
  - createDocumentLink:
      document: invoicePdf
      expiresIn: 30d
      saveAs: invoiceLink
  - sendEmail:
      template: ${t.orderInvoiceReady}
      to:
        - email: \${{ inputs.order.${t.customerEmail} }}
      data:
        invoice: \${{ invoiceLink }}
        orderNumber: \${{ inputs.order.${t.orderNumber} }}
        customerName: \${{ inputs.order.${t.customerName} }}
  - updateRecord:
      record: inputs.order
      set:
        ${t.invoiceSent}: [sent]
  - succeed:
      message: "${t.invoiceSentMessage({
        orderNumber: `\${{ inputs.order.${t.orderNumber} }}`,
        customerEmail: `\${{ inputs.order.${t.customerEmail} }}`,
      })}"`,
        enabled: true,
      },
    ],
    workflowLaunchers: [
      {
        key: "remove_order_line",
        workflow: "remove_order_line",
        name: t.removeLine,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "send_order_invoice_custom_app",
        workflow: "send_order_invoice",
        name: t.chooseOrderToSendInvoice,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
    ],
    customApps: bookshopApp(t),
  };
};

export const bookshopTemplate: GridTemplate = createBookshopTemplate("en");
