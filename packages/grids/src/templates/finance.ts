import { i18n } from "@k2b/stdlib";
import { currentMonthDate, field, form, formula, type GridTemplate, launcher, record, table, view, viewColumns } from "./types";

const financeTemplateMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      templateName: "Personal finance",
      templateDescription: "Track accounts, purchases, budgets, and receipt processing in one place.",
      highlightRecords: "Transactions, budgets, and a purchase form",
      highlightOverview: "Spending, budget, and merchant overview",
      highlightWorkflow: "Guided receipt processing and email delivery",
      baseName: "Personal Finance",
      baseDescription: "Track personal spending, income, budgets, and recent purchases.",
      accounts: "Accounts",
      accountNameDescription: "Account name shown on transactions and budgets.",
      name: "Name",
      kind: "Kind",
      accountKindDescription: "Account type used for filtering and summaries.",
      checking: "Checking",
      cash: "Cash",
      savings: "Savings",
      creditCard: "Credit card",
      openingBalance: "Opening balance",
      openingBalanceDescription: "Starting balance before imported or entered transactions.",
      categories: "Categories",
      categoryNameDescription: "Category name shown on merchants, transactions, and budgets.",
      categoryKindDescription: "Whether this category tracks income or expense.",
      income: "Income",
      expense: "Expense",
      fixed: "Fixed",
      fixedDescription: "Marks recurring categories such as rent or utilities.",
      merchants: "Merchants",
      merchantNameDescription: "Merchant, vendor, employer, or payee name.",
      defaultCategory: "Default category",
      defaultCategoryDescription: "Category suggested for future transactions from this merchant.",
      website: "Website",
      merchantWebsiteDescription: "Merchant website kept as a transaction reference.",
      transactions: "Transactions",
      transactionReference: "Transaction reference",
      transactionReferenceDescription: "Generated monthly reference for this transaction.",
      date: "Date",
      transactionDateDescription: "Transaction date.",
      merchant: "Merchant",
      transactionMerchantDescription: "Merchant or payee for this transaction.",
      account: "Account",
      transactionAccountDescription: "Account this transaction belongs to.",
      category: "Category",
      transactionCategoryDescription: "Budget or reporting category for this transaction.",
      merchantName: "Merchant name",
      merchantNameLookupDescription: "Lookup label copied from the related merchant.",
      merchantWebsite: "Merchant website",
      merchantWebsiteLookupDescription: "Lookup website copied from the related merchant.",
      categoryName: "Category name",
      categoryNameLookupDescription: "Lookup label copied from the related category.",
      type: "Type",
      transactionTypeDescription: "Transaction direction for income, expense, or transfer reporting.",
      transfer: "Transfer",
      amount: "Amount",
      amountDescription: "Transaction amount in euros.",
      cleared: "Cleared",
      clearedDescription: "Whether the transaction has cleared the account.",
      notes: "Notes",
      notesDescription: "Optional notes about this transaction.",
      receiptEmail: "Receipt email",
      receiptEmailDescription: "Recipient used by the receipt workflow.",
      receiptSent: "Receipt sent",
      receiptSentDescription: "Set once the receipt workflow has succeeded, so it is not replayed accidentally.",
      budgets: "Budgets",
      month: "Month",
      budgetMonthDescription: "Budget month.",
      budgetCategoryDescription: "Expense category this budget limits.",
      limit: "Limit",
      limitDescription: "Planned spending limit for the month and category.",
      mainAccount: "Main account",
      salary: "Salary",
      groceries: "Groceries",
      rent: "Rent",
      transport: "Transport",
      books: "Books",
      foodAndCoffee: "Food & coffee",
      utilities: "Utilities",
      employer: "Employer GmbH",
      landlord: "Landlord",
      localMarket: "Local Market",
      cityTransit: "City Transit",
      bookshop: "Bookshop",
      cornerCafe: "Corner Cafe",
      powerUtility: "Power Utility",
      recentTransactions: "Recent transactions",
      transactionCalendar: "Transaction calendar",
      monthlyBudgets: "Monthly budgets",
      logExpense: "Log expense",
      logExpenseDescription: "Add a purchase as an expense transaction.",
      logPurchase: "Log purchase",
      expenseLogged: "Expense logged.",
      purchaseDate: "Purchase date.",
      purchaseLocation: "Where the purchase happened.",
      merchantHelp: "Shop, vendor, or person.",
      merchantUrlHelp: "Optional merchant URL.",
      accountHelp: "Account or payment source.",
      categoryHelp: "Budget or spending category.",
      amountHelp: "Expense amount.",
      notesHelp: "Receipt details or context.",
      transactionReceipt: "Transaction receipt",
      transactionReceiptDescription: "Printable receipt summary for one transaction.",
      transactionReceiptReady: "Transaction receipt ready",
      transactionReceiptReadyDescription: "Sends a private download link for a transaction receipt.",
      receiptSubject: "Receipt {{ data.reference }}",
      receiptEmailHtml: `<main style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;max-width:640px;margin:0 auto;padding:32px;">
  <h1 style="font-size:24px;margin:0 0 16px;">Transaction receipt</h1>
  <p>The receipt for <strong>{{ data.reference }}</strong>{% if data.merchant %} at {{ data.merchant }}{% endif %} is ready.</p>
  <p style="margin:24px 0;"><a href="{{ data.receipt.url }}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;">Download receipt</a></p>
  <p style="color:#6b7280;font-size:14px;">This private link expires automatically.</p>
</main>`,
      clearAndSendReceipt: "Clear and send receipt",
      clearAndSendReceiptDescription: "Creates a receipt link, emails it, and marks the transaction as cleared.",
      transaction: "Transaction",
      expenseOnlyError: "Receipts can only be sent for expense transactions.",
      alreadySentError: "This receipt was already sent. Open the generated documents to download or share it again.",
      missingEmailError: "Add a receipt email address before processing this transaction.",
      sampleEmailError: "Replace the sample receipt email before sending a real receipt.",
      receiptSentSuccess: "Receipt ${{ inputs.transaction.Transaction reference }} sent and transaction cleared.",
      chooseTransaction: "Choose transaction to process receipt",
      financeOverview: "Finance overview",
      spend: "Spend",
      budget: "Budget",
      spendByCategory: "Spend by category",
      expenseTransactionsOnly: "Expense transactions only",
      monthlySpend: "Monthly spend",
      processReceipt: "Process receipt",
      logPurchaseTitle: "Log a purchase",
      monthlyIncome: "Monthly income",
    },
    de: {
      templateName: "Private Finanzen",
      templateDescription: "Konten, Ausgaben, Budgets und Belegverarbeitung an einem Ort verwalten.",
      highlightRecords: "Transaktionen, Budgets und ein Ausgabenformular",
      highlightOverview: "Übersicht über Ausgaben, Budgets und Händler",
      highlightWorkflow: "Geführte Belegverarbeitung und E-Mail-Versand",
      baseName: "Private Finanzen",
      baseDescription: "Private Ausgaben, Einnahmen, Budgets und letzte Käufe verwalten.",
      accounts: "Konten",
      accountNameDescription: "Kontoname, der bei Transaktionen und Budgets angezeigt wird.",
      name: "Name",
      kind: "Art",
      accountKindDescription: "Kontoart für Filter und Zusammenfassungen.",
      checking: "Girokonto",
      cash: "Bargeld",
      savings: "Sparkonto",
      creditCard: "Kreditkarte",
      openingBalance: "Anfangssaldo",
      openingBalanceDescription: "Saldo vor importierten oder manuell erfassten Transaktionen.",
      categories: "Kategorien",
      categoryNameDescription: "Kategoriename, der bei Händlern, Transaktionen und Budgets angezeigt wird.",
      categoryKindDescription: "Gibt an, ob die Kategorie Einnahmen oder Ausgaben erfasst.",
      income: "Einnahme",
      expense: "Ausgabe",
      fixed: "Wiederkehrend",
      fixedDescription: "Kennzeichnet wiederkehrende Kategorien wie Miete oder Nebenkosten.",
      merchants: "Händler",
      merchantNameDescription: "Name des Händlers, Anbieters, Arbeitgebers oder Zahlungsempfängers.",
      defaultCategory: "Standardkategorie",
      defaultCategoryDescription: "Kategorie, die für künftige Transaktionen dieses Händlers vorgeschlagen wird.",
      website: "Website",
      merchantWebsiteDescription: "Händlerwebsite als Referenz für Transaktionen.",
      transactions: "Transaktionen",
      transactionReference: "Transaktionsreferenz",
      transactionReferenceDescription: "Automatisch erzeugte monatliche Referenz für diese Transaktion.",
      date: "Datum",
      transactionDateDescription: "Datum der Transaktion.",
      merchant: "Händler",
      transactionMerchantDescription: "Händler oder Zahlungsempfänger dieser Transaktion.",
      account: "Konto",
      transactionAccountDescription: "Konto, zu dem diese Transaktion gehört.",
      category: "Kategorie",
      transactionCategoryDescription: "Budget- oder Berichtskategorie dieser Transaktion.",
      merchantName: "Händlername",
      merchantNameLookupDescription: "Aus dem verknüpften Händler übernommene Bezeichnung.",
      merchantWebsite: "Händlerwebsite",
      merchantWebsiteLookupDescription: "Aus dem verknüpften Händler übernommene Website.",
      categoryName: "Kategoriename",
      categoryNameLookupDescription: "Aus der verknüpften Kategorie übernommene Bezeichnung.",
      type: "Typ",
      transactionTypeDescription: "Richtung der Transaktion für Einnahmen-, Ausgaben- oder Umbuchungsberichte.",
      transfer: "Umbuchung",
      amount: "Betrag",
      amountDescription: "Transaktionsbetrag in Euro.",
      cleared: "Gebucht",
      clearedDescription: "Gibt an, ob die Transaktion auf dem Konto gebucht wurde.",
      notes: "Notizen",
      notesDescription: "Optionale Notizen zu dieser Transaktion.",
      receiptEmail: "E-Mail-Adresse für Beleg",
      receiptEmailDescription: "Empfängeradresse für den Beleg-Workflow.",
      receiptSent: "Beleg gesendet",
      receiptSentDescription:
        "Wird nach erfolgreichem Abschluss des Beleg-Workflows gesetzt, damit er nicht versehentlich erneut ausgeführt wird.",
      budgets: "Budgets",
      month: "Monat",
      budgetMonthDescription: "Monat des Budgets.",
      budgetCategoryDescription: "Ausgabenkategorie, die durch dieses Budget begrenzt wird.",
      limit: "Limit",
      limitDescription: "Geplantes Ausgabenlimit für den Monat und die Kategorie.",
      mainAccount: "Hauptkonto",
      salary: "Gehalt",
      groceries: "Lebensmittel",
      rent: "Miete",
      transport: "Mobilität",
      books: "Bücher",
      foodAndCoffee: "Essen & Kaffee",
      utilities: "Nebenkosten",
      employer: "Arbeitgeber GmbH",
      landlord: "Vermieter",
      localMarket: "Markt vor Ort",
      cityTransit: "Stadtverkehr",
      bookshop: "Buchhandlung",
      cornerCafe: "Café an der Ecke",
      powerUtility: "Stromversorger",
      recentTransactions: "Letzte Transaktionen",
      transactionCalendar: "Transaktionskalender",
      monthlyBudgets: "Monatliche Budgets",
      logExpense: "Ausgabe erfassen",
      logExpenseDescription: "Einen Kauf als Ausgabentransaktion hinzufügen.",
      logPurchase: "Kauf erfassen",
      expenseLogged: "Ausgabe erfasst.",
      purchaseDate: "Datum des Kaufs.",
      purchaseLocation: "Ort des Kaufs.",
      merchantHelp: "Geschäft, Anbieter oder Person.",
      merchantUrlHelp: "Optionale URL des Händlers.",
      accountHelp: "Konto oder Zahlungsquelle.",
      categoryHelp: "Budget- oder Ausgabenkategorie.",
      amountHelp: "Betrag der Ausgabe.",
      notesHelp: "Belegdetails oder weitere Hinweise.",
      transactionReceipt: "Transaktionsbeleg",
      transactionReceiptDescription: "Druckbare Belegübersicht für eine Transaktion.",
      transactionReceiptReady: "Transaktionsbeleg verfügbar",
      transactionReceiptReadyDescription: "Sendet einen privaten Download-Link für einen Transaktionsbeleg.",
      receiptSubject: "Beleg {{ data.reference }}",
      receiptEmailHtml: `<main style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;max-width:640px;margin:0 auto;padding:32px;">
  <h1 style="font-size:24px;margin:0 0 16px;">Transaktionsbeleg</h1>
  <p>Der Beleg für <strong>{{ data.reference }}</strong>{% if data.merchant %} bei {{ data.merchant }}{% endif %} ist verfügbar.</p>
  <p style="margin:24px 0;"><a href="{{ data.receipt.url }}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;">Beleg herunterladen</a></p>
  <p style="color:#6b7280;font-size:14px;">Dieser private Link läuft automatisch ab.</p>
</main>`,
      clearAndSendReceipt: "Beleg buchen und senden",
      clearAndSendReceiptDescription: "Erstellt einen Beleg-Link, sendet ihn per E-Mail und markiert die Transaktion als gebucht.",
      transaction: "Transaktion",
      expenseOnlyError: "Belege können nur für Ausgabentransaktionen gesendet werden.",
      alreadySentError: "Dieser Beleg wurde bereits gesendet. Öffne die erzeugten Dokumente, um ihn erneut herunterzuladen oder zu teilen.",
      missingEmailError: "Füge eine E-Mail-Adresse für den Beleg hinzu, bevor du diese Transaktion verarbeitest.",
      sampleEmailError: "Ersetze die Beispieladresse, bevor du einen echten Beleg sendest.",
      receiptSentSuccess: "Beleg ${{ inputs.transaction.Transaktionsreferenz }} gesendet und Transaktion gebucht.",
      chooseTransaction: "Transaktion für die Belegverarbeitung auswählen",
      financeOverview: "Finanzübersicht",
      spend: "Ausgaben",
      budget: "Budget",
      spendByCategory: "Ausgaben nach Kategorie",
      expenseTransactionsOnly: "Nur Ausgabentransaktionen",
      monthlySpend: "Monatliche Ausgaben",
      processReceipt: "Beleg verarbeiten",
      logPurchaseTitle: "Kauf erfassen",
      monthlyIncome: "Monatliche Einnahmen",
    },
  },
});

const monthlySpendSource = () =>
  formula(
    "from table ",
    table("transactions"),
    "\nwhere ",
    field("transactions.type"),
    " = 'expense'\ngroup by ",
    field("transactions.date"),
    " by month\naggregate sum(",
    field("transactions.amount"),
    ") as monthly_spend\nsort ",
    field("transactions.date"),
    " asc",
  );

export const createFinanceTemplate = (locale?: string): GridTemplate => {
  const { t } = financeTemplateMessages.resolve([locale ?? "en"]);

  return {
    id: "finance",
    name: t.templateName,
    description: t.templateDescription,
    highlights: [t.highlightRecords, t.highlightOverview, t.highlightWorkflow],
    icon: "ti ti-wallet",
    baseName: t.baseName,
    baseDescription: t.baseDescription,
    tables: [
      {
        key: "accounts",
        name: t.accounts,
        fields: [
          {
            key: "name",
            name: t.name,
            description: t.accountNameDescription,
            type: "text",
            required: true,
            presentable: true,
            icon: "ti ti-credit-card",
          },
          {
            key: "kind",
            name: t.kind,
            description: t.accountKindDescription,
            type: "select",
            icon: "ti ti-category",
            config: {
              options: [
                { id: "checking", label: t.checking, color: "#3b82f6" },
                { id: "cash", label: t.cash, color: "#22c55e" },
                { id: "savings", label: t.savings, color: "#a855f7" },
                { id: "credit", label: t.creditCard, color: "#f59e0b" },
              ],
            },
          },
          {
            key: "opening_balance",
            name: t.openingBalance,
            description: t.openingBalanceDescription,
            type: "number",
            icon: "ti ti-currency-euro",
            config: {
              precision: 16,
              decimalPlaces: 2,
              unit: "EUR",
              unitPosition: "suffix",
            },
          },
        ],
      },
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
            key: "kind",
            name: t.kind,
            description: t.categoryKindDescription,
            type: "select",
            icon: "ti ti-arrows-exchange",
            config: {
              options: [
                { id: "income", label: t.income, color: "#22c55e" },
                { id: "expense", label: t.expense, color: "#ef4444" },
              ],
            },
          },
          {
            key: "fixed",
            name: t.fixed,
            description: t.fixedDescription,
            type: "boolean",
            icon: "ti ti-lock",
            defaultValue: false,
          },
        ],
      },
      {
        key: "merchants",
        name: t.merchants,
        fields: [
          {
            key: "name",
            name: t.name,
            description: t.merchantNameDescription,
            type: "text",
            required: true,
            presentable: true,
            icon: "ti ti-building-store",
          },
          {
            key: "default_category",
            name: t.defaultCategory,
            description: t.defaultCategoryDescription,
            type: "relation",
            icon: "ti ti-tag",
            config: { targetTableId: table("categories"), cardinality: "single" },
          },
          {
            key: "website",
            name: t.website,
            description: t.merchantWebsiteDescription,
            type: "text",
            config: { regex: "^https?://.+" },
            icon: "ti ti-world",
          },
        ],
      },
      {
        key: "transactions",
        name: t.transactions,
        fields: [
          {
            key: "transaction_ref",
            name: t.transactionReference,
            description: t.transactionReferenceDescription,
            type: "id",
            config: {
              strategy: "date_sequence",
              prefix: "TX-",
              period: "month",
              padding: 4,
            },
            presentable: true,
            icon: "ti ti-id",
          },
          {
            key: "date",
            name: t.date,
            description: t.transactionDateDescription,
            type: "date",
            required: true,
            icon: "ti ti-calendar",
          },
          {
            key: "merchant",
            name: t.merchant,
            description: t.transactionMerchantDescription,
            type: "relation",
            required: true,
            icon: "ti ti-building-store",
            config: { targetTableId: table("merchants"), cardinality: "single" },
          },
          {
            key: "account",
            name: t.account,
            description: t.transactionAccountDescription,
            type: "relation",
            required: true,
            icon: "ti ti-credit-card",
            config: { targetTableId: table("accounts"), cardinality: "single" },
          },
          {
            key: "category",
            name: t.category,
            description: t.transactionCategoryDescription,
            type: "relation",
            required: true,
            icon: "ti ti-tag",
            config: { targetTableId: table("categories"), cardinality: "single" },
          },
          {
            key: "merchant_name",
            name: t.merchantName,
            description: t.merchantNameLookupDescription,
            type: "lookup",
            icon: "ti ti-hierarchy",
            config: {
              relationFieldId: field("transactions.merchant"),
              targetFieldId: field("merchants.name"),
            },
          },
          {
            key: "merchant_website",
            name: t.merchantWebsite,
            description: t.merchantWebsiteLookupDescription,
            type: "lookup",
            icon: "ti ti-qrcode",
            config: {
              relationFieldId: field("transactions.merchant"),
              targetFieldId: field("merchants.website"),
            },
          },
          {
            key: "category_name",
            name: t.categoryName,
            description: t.categoryNameLookupDescription,
            type: "lookup",
            icon: "ti ti-hierarchy",
            config: {
              relationFieldId: field("transactions.category"),
              targetFieldId: field("categories.name"),
            },
          },
          {
            key: "type",
            name: t.type,
            description: t.transactionTypeDescription,
            type: "select",
            required: true,
            icon: "ti ti-arrows-exchange",
            config: {
              options: [
                { id: "expense", label: t.expense, color: "#ef4444" },
                { id: "income", label: t.income, color: "#22c55e" },
                { id: "transfer", label: t.transfer, color: "#94a3b8" },
              ],
            },
          },
          {
            key: "amount",
            name: t.amount,
            description: t.amountDescription,
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
            key: "cleared",
            name: t.cleared,
            description: t.clearedDescription,
            type: "boolean",
            icon: "ti ti-circle-check",
            defaultValue: false,
          },
          {
            key: "notes",
            name: t.notes,
            description: t.notesDescription,
            type: "longtext",
            icon: "ti ti-notes",
          },
          {
            key: "receipt_email",
            name: t.receiptEmail,
            description: t.receiptEmailDescription,
            type: "text",
            required: true,
            icon: "ti ti-mail",
            config: { regex: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
            defaultValue: "receipts@example.test",
          },
          {
            key: "receipt_sent",
            name: t.receiptSent,
            description: t.receiptSentDescription,
            type: "boolean",
            icon: "ti ti-mail-check",
            defaultValue: false,
          },
        ],
      },
      {
        key: "budgets",
        name: t.budgets,
        fields: [
          {
            key: "month",
            name: t.month,
            description: t.budgetMonthDescription,
            type: "date",
            required: true,
            presentable: true,
            icon: "ti ti-calendar-month",
          },
          {
            key: "category",
            name: t.category,
            description: t.budgetCategoryDescription,
            type: "relation",
            required: true,
            icon: "ti ti-tag",
            config: { targetTableId: table("categories"), cardinality: "single" },
          },
          {
            key: "limit",
            name: t.limit,
            description: t.limitDescription,
            type: "number",
            required: true,
            icon: "ti ti-currency-euro",
            config: {
              precision: 16,
              decimalPlaces: 2,
              unit: "EUR",
              unitPosition: "suffix",
            },
          },
        ],
      },
    ],
    records: [
      {
        key: "accounts.main",
        table: "accounts",
        values: {
          name: t.mainAccount,
          kind: ["checking"],
          opening_balance: "2450.00",
        },
      },
      {
        key: "accounts.savings",
        table: "accounts",
        values: {
          name: t.savings,
          kind: ["savings"],
          opening_balance: "8400.00",
        },
      },
      {
        key: "accounts.cash",
        table: "accounts",
        values: { name: t.cash, kind: ["cash"], opening_balance: "120.00" },
      },
      {
        key: "accounts.card",
        table: "accounts",
        values: { name: "Visa", kind: ["credit"], opening_balance: "0.00" },
      },
      {
        key: "categories.salary",
        table: "categories",
        values: { name: t.salary, kind: ["income"], fixed: true },
      },
      {
        key: "categories.groceries",
        table: "categories",
        values: { name: t.groceries, kind: ["expense"], fixed: false },
      },
      {
        key: "categories.rent",
        table: "categories",
        values: { name: t.rent, kind: ["expense"], fixed: true },
      },
      {
        key: "categories.transport",
        table: "categories",
        values: { name: t.transport, kind: ["expense"], fixed: false },
      },
      {
        key: "categories.books",
        table: "categories",
        values: { name: t.books, kind: ["expense"], fixed: false },
      },
      {
        key: "categories.food",
        table: "categories",
        values: { name: t.foodAndCoffee, kind: ["expense"], fixed: false },
      },
      {
        key: "categories.utilities",
        table: "categories",
        values: { name: t.utilities, kind: ["expense"], fixed: true },
      },
      {
        key: "merchants.employer",
        table: "merchants",
        values: {
          name: t.employer,
          default_category: [record("categories.salary")],
          website: "https://employer.example",
        },
      },
      {
        key: "merchants.landlord",
        table: "merchants",
        values: {
          name: t.landlord,
          default_category: [record("categories.rent")],
          website: "https://rent.example",
        },
      },
      {
        key: "merchants.market",
        table: "merchants",
        values: {
          name: t.localMarket,
          default_category: [record("categories.groceries")],
          website: "https://market.example",
        },
      },
      {
        key: "merchants.transit",
        table: "merchants",
        values: {
          name: t.cityTransit,
          default_category: [record("categories.transport")],
          website: "https://transit.example",
        },
      },
      {
        key: "merchants.bookshop",
        table: "merchants",
        values: {
          name: t.bookshop,
          default_category: [record("categories.books")],
          website: "https://bookshop.example",
        },
      },
      {
        key: "merchants.cafe",
        table: "merchants",
        values: {
          name: t.cornerCafe,
          default_category: [record("categories.food")],
          website: "https://cafe.example",
        },
      },
      {
        key: "merchants.power",
        table: "merchants",
        values: {
          name: t.powerUtility,
          default_category: [record("categories.utilities")],
          website: "https://power.example",
        },
      },
      {
        key: "transactions.salary_apr",
        table: "transactions",
        values: {
          date: "2026-04-01",
          merchant: [record("merchants.employer")],
          account: [record("accounts.main")],
          category: [record("categories.salary")],
          type: ["income"],
          amount: "3200.00",
          cleared: true,
        },
      },
      {
        key: "transactions.rent_apr",
        table: "transactions",
        values: {
          date: "2026-04-02",
          merchant: [record("merchants.landlord")],
          account: [record("accounts.main")],
          category: [record("categories.rent")],
          type: ["expense"],
          amount: "980.00",
          cleared: true,
        },
      },
      {
        key: "transactions.market_apr",
        table: "transactions",
        values: {
          date: "2026-04-05",
          merchant: [record("merchants.market")],
          account: [record("accounts.card")],
          category: [record("categories.groceries")],
          type: ["expense"],
          amount: "76.40",
          cleared: true,
        },
      },
      {
        key: "transactions.cafe_apr",
        table: "transactions",
        values: {
          date: "2026-04-09",
          merchant: [record("merchants.cafe")],
          account: [record("accounts.card")],
          category: [record("categories.food")],
          type: ["expense"],
          amount: "14.80",
          cleared: true,
        },
      },
      {
        key: "transactions.books_apr",
        table: "transactions",
        values: {
          date: "2026-04-18",
          merchant: [record("merchants.bookshop")],
          account: [record("accounts.cash")],
          category: [record("categories.books")],
          type: ["expense"],
          amount: "28.90",
          cleared: true,
        },
      },
      {
        key: "transactions.salary_may",
        table: "transactions",
        values: {
          date: currentMonthDate(1),
          merchant: [record("merchants.employer")],
          account: [record("accounts.main")],
          category: [record("categories.salary")],
          type: ["income"],
          amount: "3200.00",
          cleared: true,
        },
      },
      {
        key: "transactions.rent_may",
        table: "transactions",
        values: {
          date: currentMonthDate(2),
          merchant: [record("merchants.landlord")],
          account: [record("accounts.main")],
          category: [record("categories.rent")],
          type: ["expense"],
          amount: "980.00",
          cleared: true,
        },
      },
      {
        key: "transactions.power_may",
        table: "transactions",
        values: {
          date: currentMonthDate(3),
          merchant: [record("merchants.power")],
          account: [record("accounts.main")],
          category: [record("categories.utilities")],
          type: ["expense"],
          amount: "92.30",
          cleared: true,
        },
      },
      {
        key: "transactions.market_may_1",
        table: "transactions",
        values: {
          date: currentMonthDate(4),
          merchant: [record("merchants.market")],
          account: [record("accounts.card")],
          category: [record("categories.groceries")],
          type: ["expense"],
          amount: "82.40",
          cleared: true,
        },
      },
      {
        key: "transactions.transit_may",
        table: "transactions",
        values: {
          date: currentMonthDate(6),
          merchant: [record("merchants.transit")],
          account: [record("accounts.card")],
          category: [record("categories.transport")],
          type: ["expense"],
          amount: "58.00",
          cleared: true,
        },
      },
      {
        key: "transactions.cafe_may_1",
        table: "transactions",
        values: {
          date: currentMonthDate(8),
          merchant: [record("merchants.cafe")],
          account: [record("accounts.card")],
          category: [record("categories.food")],
          type: ["expense"],
          amount: "12.60",
          cleared: true,
        },
      },
      {
        key: "transactions.bookshop_may",
        table: "transactions",
        values: {
          date: currentMonthDate(9),
          merchant: [record("merchants.bookshop")],
          account: [record("accounts.cash")],
          category: [record("categories.books")],
          type: ["expense"],
          amount: "31.90",
          cleared: true,
        },
      },
      {
        key: "transactions.market_may_2",
        table: "transactions",
        values: {
          date: currentMonthDate(11),
          merchant: [record("merchants.market")],
          account: [record("accounts.card")],
          category: [record("categories.groceries")],
          type: ["expense"],
          amount: "64.20",
          cleared: false,
        },
      },
      {
        key: "transactions.cafe_may_2",
        table: "transactions",
        values: {
          date: currentMonthDate(12),
          merchant: [record("merchants.cafe")],
          account: [record("accounts.card")],
          category: [record("categories.food")],
          type: ["expense"],
          amount: "9.90",
          cleared: false,
        },
      },
      {
        key: "budgets.rent",
        table: "budgets",
        values: {
          month: currentMonthDate(1),
          category: [record("categories.rent")],
          limit: "980.00",
        },
      },
      {
        key: "budgets.groceries",
        table: "budgets",
        values: {
          month: currentMonthDate(1),
          category: [record("categories.groceries")],
          limit: "450.00",
        },
      },
      {
        key: "budgets.transport",
        table: "budgets",
        values: {
          month: currentMonthDate(1),
          category: [record("categories.transport")],
          limit: "120.00",
        },
      },
      {
        key: "budgets.books",
        table: "budgets",
        values: {
          month: currentMonthDate(1),
          category: [record("categories.books")],
          limit: "80.00",
        },
      },
      {
        key: "budgets.food",
        table: "budgets",
        values: {
          month: currentMonthDate(1),
          category: [record("categories.food")],
          limit: "160.00",
        },
      },
      {
        key: "budgets.previous_groceries",
        table: "budgets",
        values: {
          month: currentMonthDate(1, -1),
          category: [record("categories.groceries")],
          limit: "400.00",
        },
      },
    ],
    views: [
      {
        key: "recent_transactions",
        table: "transactions",
        name: t.recentTransactions,
        shared: true,
        source: formula(
          "from table ",
          table("transactions"),
          "\nselect ",
          field("transactions.transaction_ref"),
          ", ",
          field("transactions.date"),
          ", ",
          field("transactions.merchant"),
          ", ",
          field("transactions.merchant_website"),
          ", ",
          field("transactions.category"),
          ", ",
          field("transactions.type"),
          ", ",
          field("transactions.amount"),
          ", ",
          field("transactions.cleared"),
          "\nsort ",
          field("transactions.date"),
          " desc\nlimit 50",
        ),
        ui: {
          columns: [
            { fieldId: field("transactions.transaction_ref") },
            { fieldId: field("transactions.date") },
            { fieldId: field("transactions.merchant") },
            {
              fieldId: field("transactions.merchant_website"),
              label: t.merchantWebsite,
            },
            { fieldId: field("transactions.category") },
            { fieldId: field("transactions.type") },
            { fieldId: field("transactions.amount") },
            { fieldId: field("transactions.cleared") },
          ],
        },
      },
      {
        key: "transaction_calendar",
        table: "transactions",
        name: t.transactionCalendar,
        shared: true,
        source: formula(
          "from table ",
          table("transactions"),
          "\nselect ",
          field("transactions.date"),
          ", ",
          field("transactions.merchant"),
          ", ",
          field("transactions.category"),
          ", ",
          field("transactions.type"),
          ", ",
          field("transactions.amount"),
          "\nsort ",
          field("transactions.date"),
          " desc\nlimit 100",
        ),
        ui: {
          displayConfig: {
            mode: "calendar",
            calendar: { dateFieldId: field("transactions.date") },
          },
        },
      },
      {
        key: "budgets",
        table: "budgets",
        name: t.monthlyBudgets,
        shared: true,
        source: formula(
          "from table ",
          table("budgets"),
          "\nselect ",
          field("budgets.month"),
          ", ",
          field("budgets.category"),
          ", ",
          field("budgets.limit"),
          "\nsort ",
          field("budgets.limit"),
          " desc",
        ),
      },
    ],
    forms: [
      {
        key: "log_expense",
        table: "transactions",
        name: t.logExpense,
        config: {
          title: t.logExpense,
          description: t.logExpenseDescription,
          submitLabel: t.logPurchase,
          successMessage: t.expenseLogged,
          fields: [
            {
              kind: "user_input",
              fieldId: field("transactions.date"),
              label: t.date,
              helpText: t.purchaseDate,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("transactions.merchant"),
              label: t.merchant,
              helpText: t.purchaseLocation,
              required: true,
              inlineCreate: {
                enabled: true,
                fields: [
                  {
                    fieldId: field("merchants.name"),
                    label: t.merchantName,
                    helpText: t.merchantHelp,
                    required: true,
                  },
                  {
                    fieldId: field("merchants.website"),
                    label: t.website,
                    helpText: t.merchantUrlHelp,
                  },
                ],
              },
            },
            {
              kind: "user_input",
              fieldId: field("transactions.account"),
              label: t.account,
              helpText: t.accountHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("transactions.category"),
              label: t.category,
              helpText: t.categoryHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("transactions.amount"),
              label: t.amount,
              helpText: t.amountHelp,
              required: true,
            },
            {
              kind: "user_input",
              fieldId: field("transactions.notes"),
              label: t.notes,
              helpText: t.notesHelp,
            },
            {
              kind: "user_input",
              fieldId: field("transactions.receipt_email"),
              label: t.receiptEmail,
              helpText: t.receiptEmailDescription,
              required: true,
            },
            {
              kind: "form_value",
              fieldId: field("transactions.type"),
              value: ["expense"],
            },
            {
              kind: "form_value",
              fieldId: field("transactions.cleared"),
              value: false,
            },
            {
              kind: "form_value",
              fieldId: field("transactions.receipt_sent"),
              value: false,
            },
          ],
        },
      },
    ],
    documentTemplates: [
      {
        key: "transaction_receipt",
        table: "transactions",
        starterId: "record-detail",
        name: t.transactionReceipt,
        description: t.transactionReceiptDescription,
        source: formula(
          "from table ",
          table("transactions"),
          "\nselect ",
          field("transactions.transaction_ref"),
          " as reference, ",
          field("transactions.date"),
          ", ",
          field("transactions.merchant_name"),
          " as merchant_label, ",
          field("transactions.category_name"),
          " as category_label, ",
          field("transactions.type"),
          ", ",
          field("transactions.amount"),
          ", ",
          field("transactions.cleared"),
          ", ",
          field("transactions.receipt_sent"),
          ", ",
          field("transactions.notes"),
          "\nwhere record.id = '{{ record.id }}'\nlimit 1",
        ),
        enabled: true,
      },
    ],
    emailTemplates: [
      {
        key: "transaction_receipt_ready",
        name: t.transactionReceiptReady,
        description: t.transactionReceiptReadyDescription,
        subject: t.receiptSubject,
        html: t.receiptEmailHtml,
        sampleData: {
          reference: "TX-2026-0042",
          merchant: "Office Supply GmbH",
          receipt: {
            url: "https://cloud.example.org/share/grids/documents/example",
          },
        },
        enabled: true,
      },
    ],
    workflows: [
      {
        key: "clear_and_send_receipt",
        name: t.clearAndSendReceipt,
        description: t.clearAndSendReceiptDescription,
        source: `inputs:
  transaction:
    type: record
    table: ${t.transactions}
    label: ${t.transaction}
    required: true
steps:
  - if:
      notEquals:
        - \${{ inputs.transaction.${t.type} }}
        - [expense]
    then:
      - fail:
          message: ${t.expenseOnlyError}
  - if:
      equals:
        - \${{ inputs.transaction.${t.receiptSent} }}
        - true
    then:
      - fail:
          message: ${t.alreadySentError}
  - if:
      not:
        exists: inputs.transaction.${t.receiptEmail}
    then:
      - fail:
          message: ${t.missingEmailError}
  - if:
      endsWith:
        - \${{ inputs.transaction.${t.receiptEmail} }}
        - .test
    then:
      - fail:
          message: ${t.sampleEmailError}
  - generateDocument:
      template: ${t.transactionReceipt}
      record: inputs.transaction
      saveAs: receiptPdf
  - createDocumentLink:
      document: receiptPdf
      expiresIn: 30d
      saveAs: receiptLink
  - sendEmail:
      template: ${t.transactionReceiptReady}
      to:
        - email: \${{ inputs.transaction.${t.receiptEmail} }}
      data:
        receipt: \${{ receiptLink }}
        reference: \${{ inputs.transaction.${t.transactionReference} }}
        merchant: \${{ inputs.transaction.${t.merchantName} }}
  - updateRecord:
      record: inputs.transaction
      set:
        ${t.cleared}: true
        ${t.receiptSent}: true
  - succeed:
      message: "${t.receiptSentSuccess}"`,
        enabled: true,
      },
    ],
    workflowLaunchers: [
      {
        key: "clear_and_send_receipt_custom_app",
        workflow: "clear_and_send_receipt",
        name: t.chooseTransaction,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
    ],
    customApps: [
      {
        key: "overview",
        definition: {
          schemaVersion: 5,
          kind: "grids.custom-app",
          name: t.financeOverview,
          startPageId: "overview",
          pages: [
            {
              id: "overview",
              title: t.financeOverview,
              navigation: {
                visible: true,
              },
              parameters: {},
              rows: [
                {
                  id: "r-stats",
                  columns: [
                    {
                      id: "w-income-column",
                      span: 3,
                      blocks: [
                        {
                          id: "w-income",
                          type: "metrics",
                          title: t.income,
                          source: {
                            kind: "gql",
                            query: formula(
                              "from table ",
                              table("transactions"),
                              "\nwhere ",
                              field("transactions.type"),
                              " = 'income'\naggregate sum(",
                              field("transactions.amount"),
                              ") as total_income",
                            ),
                          },
                        },
                      ],
                    },
                    {
                      id: "w-spend-column",
                      span: 3,
                      blocks: [
                        {
                          id: "w-spend",
                          type: "metrics",
                          title: t.spend,
                          source: {
                            kind: "gql",
                            query: formula(
                              "from table ",
                              table("transactions"),
                              "\nwhere ",
                              field("transactions.type"),
                              " = 'expense'\naggregate sum(",
                              field("transactions.amount"),
                              ") as total_spend",
                            ),
                          },
                        },
                      ],
                    },
                    {
                      id: "w-tx-column",
                      span: 3,
                      blocks: [
                        {
                          id: "w-tx",
                          type: "metrics",
                          title: t.transactions,
                          source: {
                            kind: "gql",
                            query: formula("from table ", table("transactions"), "\naggregate count(*) as transaction_count"),
                          },
                        },
                      ],
                    },
                    {
                      id: "w-budget-column",
                      span: 3,
                      blocks: [
                        {
                          id: "w-budget",
                          type: "metrics",
                          title: t.budget,
                          source: {
                            kind: "gql",
                            query: formula(
                              "from table ",
                              table("budgets"),
                              "\nwhere YEAR(",
                              field("budgets.month"),
                              ") = YEAR(TODAY()) and MONTH(",
                              field("budgets.month"),
                              ") = MONTH(TODAY())\naggregate sum(",
                              field("budgets.limit"),
                              ") as total_budget",
                            ),
                          },
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "r-charts",
                  columns: [
                    {
                      id: "w-spend-cat-column",
                      span: 6,
                      blocks: [
                        {
                          id: "w-spend-cat",
                          type: "chart",
                          title: t.spendByCategory,
                          subtitle: t.expenseTransactionsOnly,
                          chartType: "donut",
                          source: {
                            kind: "gql",
                            query: formula(
                              "from table ",
                              table("transactions"),
                              "\njoin table ",
                              table("categories"),
                              " as category on ",
                              field("transactions.category"),
                              " = category.id\nwhere ",
                              field("transactions.type"),
                              " = 'expense'\ngroup by category.",
                              field("categories.name"),
                              "\naggregate sum(",
                              field("transactions.amount"),
                              ") as category_spend\nhaving category_spend > 0\nsort category_spend desc nulls last",
                            ),
                          },
                          limit: 100,
                        },
                      ],
                    },
                    {
                      id: "w-monthly-column",
                      span: 6,
                      blocks: [
                        {
                          id: "w-monthly",
                          type: "chart",
                          title: t.monthlySpend,
                          chartType: "bar",
                          source: {
                            kind: "gql",
                            query: monthlySpendSource(),
                          },
                          valueFormat: {
                            style: "number",
                            decimalPlaces: 2,
                            unit: "EUR",
                            unitPosition: "suffix",
                          },
                          yAxisLabel: "EUR",
                          limit: 100,
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "r-work",
                  columns: [
                    {
                      id: "w-recent-column",
                      span: 7,
                      blocks: [
                        {
                          id: "w-recent",
                          type: "records",
                          searchable: true,
                          pageSize: 25,
                          title: t.recentTransactions,
                          source: { kind: "view", viewId: view("recent_transactions") },
                          display: {
                            kind: "table",
                            columnIds: viewColumns("recent_transactions"),
                          },
                          rowActions: [
                            {
                              id: "send-receipt",
                              label: t.processReceipt,
                              showLabel: true,
                              kind: "workflow",
                              launcherId: launcher("clear_and_send_receipt_custom_app"),
                              inputs: { transaction: { source: "ROW", path: "id" } },
                            },
                          ],
                        },
                      ],
                    },
                    {
                      id: "w-log-column",
                      span: 5,
                      blocks: [
                        {
                          id: "w-log",
                          type: "form",
                          title: t.logPurchaseTitle,
                          formId: form("log_expense"),
                          fixedValues: {},
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "r-budget",
                  columns: [
                    {
                      id: "w-budgets-column",
                      span: 6,
                      blocks: [
                        {
                          id: "w-budgets",
                          type: "records",
                          searchable: true,
                          pageSize: 25,
                          title: t.monthlyBudgets,
                          source: { kind: "view", viewId: view("budgets") },
                          display: {
                            kind: "table",
                            columnIds: viewColumns("budgets"),
                          },
                        },
                      ],
                    },
                    {
                      id: "w-income-chart-column",
                      span: 6,
                      blocks: [
                        {
                          id: "w-income-chart",
                          type: "chart",
                          title: t.monthlyIncome,
                          chartType: "bar",
                          source: {
                            kind: "gql",
                            query: formula(
                              "from table ",
                              table("transactions"),
                              "\nwhere ",
                              field("transactions.type"),
                              " = 'income'\ngroup by ",
                              field("transactions.date"),
                              " by month\naggregate sum(",
                              field("transactions.amount"),
                              ") as monthly_income\nsort ",
                              field("transactions.date"),
                              " asc",
                            ),
                          },
                          valueFormat: {
                            style: "number",
                            decimalPlaces: 2,
                            unit: "EUR",
                            unitPosition: "suffix",
                          },
                          limit: 100,
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
  };
};

export const financeTemplate: GridTemplate = createFinanceTemplate("en");
