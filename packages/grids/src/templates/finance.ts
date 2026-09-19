import { i18n } from "@k2b/stdlib";
import { financeApp, financeBudgetViews } from "./finance-app";
import { financeForms } from "./finance-forms";
import { currentMonthDate, field, formula, type GridTemplate, record, table } from "./types";

const financeTemplateMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      overview: "This month",
      overviewHelp:
        "Income, spending and budgets refer to the current calendar month. Recorded expenses count immediately, including entries not yet reconciled. This is a personal spending log, not a live bank balance.",
      activity: "All transactions",
      review: "To reconcile",
      reviewHelp:
        "Compare these entries with your bank statement or cash balance. Open an entry, correct it if needed and mark it as reconciled. No bank connection or payment is initiated.",
      noReview: "Everything recorded has been reconciled.",
      noTransactions: "No transactions yet. Start by recording an expense or income.",
      logIncome: "Record income",
      incomeLogged: "Income recorded.",
      editTransaction: "Edit transaction",
      saveChanges: "Save changes",
      changesSaved: "Changes saved.",
      plan: "Budget plan",
      budgetHelp:
        "All amounts in EUR. Set one budget per category and calendar month. Edit an existing budget instead of adding another: duplicate limits are added together in the monthly total. Current-month expenses are compared with each limit; a negative remainder means you are over budget. Transfers and income are excluded.",
      newBudget: "Set a budget",
      editBudget: "Edit budget",
      budgetSaved: "Budget saved.",
      budgetHistory: "Budget history",
      remaining: "Remaining",
      spent: "Spent",
      currentBudgets: "Budgets this month",
      budgetSpendTotals: "Current-month spending by category",
      budgetLimitTotals: "Current-month budget totals",
      categoryTransactions: "View category transactions",
      noBudgets: "No budget set for this month. Set a budget to compare planned and actual spending.",
      setup: "Accounts & categories",
      setupHelp:
        "Set up the accounts and categories used when recording transactions. Opening balances are reference information; this app does not calculate bank balances or manage paired transfers.",
      newAccount: "Add account",
      newCategory: "Add category",
      details: "Details",
      receiptHelp:
        "Optional: send a printable summary of this expense. It is not the merchant’s original receipt. Add a real recipient first. Email delivery never reconciles the transaction.",
      viewSummary: "Transaction summary",
      sendConfirm: "Send this transaction summary to the saved recipient?",
      savedHelp: "Record the amount as a positive value. Choose the account and category; income and expenses are reported separately.",
      additional: "Optional details",
      editAccount: "Edit account",
      editCategory: "Edit category",
      templateName: "Personal finance",
      receiptJourney:
        "Review the transaction and replace the example receipt email with the intended recipient before processing. The action creates a transaction summary and sends it by email; it does not retrieve the merchant's original receipt or make a payment. Generated documents appear below.",
      templateDescription: "Track accounts, purchases, budgets, and receipt processing in one place.",
      highlightRecords: "Transactions, budgets, and a purchase form",
      highlightOverview: "Spending, budgets, and payment partners",
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
      merchants: "Payees & senders",
      merchantNameDescription: "Name of the person, business or employer.",
      defaultCategory: "Default category",
      defaultCategoryDescription: "Usual category for this merchant; select the category when entering a transaction.",
      website: "Website",
      merchantWebsiteDescription: "Merchant website kept as a transaction reference.",
      transactions: "Transactions",
      transactionReference: "Transaction reference",
      transactionReferenceDescription: "Generated monthly reference for this transaction.",
      date: "Date",
      transactionDateDescription: "Transaction date.",
      merchant: "Payee or sender",
      transactionMerchantDescription: "Who did you pay, or who did you receive the money from?",
      account: "Account",
      transactionAccountDescription: "Account this transaction belongs to.",
      category: "Category",
      transactionCategoryDescription: "Budget or reporting category for this transaction.",
      merchantName: "Partner name",
      merchantNameLookupDescription: "Lookup label copied from the related merchant.",
      merchantWebsite: "Partner website",
      merchantWebsiteLookupDescription: "Lookup website copied from the related merchant.",
      categoryName: "Category name",
      categoryNameLookupDescription: "Lookup label copied from the related category.",
      type: "Type",
      transactionTypeDescription: "Transaction direction for income, expense, or transfer reporting.",
      transfer: "Transfer",
      amount: "Amount",
      amountDescription: "Transaction amount in euros.",
      cleared: "Reconciled",
      clearedDescription: "Checked against the bank statement or cash balance. Receipt delivery does not change this.",
      notes: "Notes",
      notesDescription: "Optional notes about this transaction.",
      receiptEmail: "Receipt email",
      receiptEmailDescription: "Optional. Required only when sending a transaction summary.",
      receiptSent: "Receipt delivery",
      receiptSentDescription:
        "Ready, in progress, or sent. Inspect the original run before resetting an interrupted delivery; it may already have sent email.",
      deliveryReady: "Ready",
      deliveryProcessing: "In progress",
      deliverySent: "Sent",
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
      merchantHelp: "Person, business or employer.",
      merchantUrlHelp: "Optional merchant URL.",
      accountHelp: "Account or payment source.",
      categoryHelp: "Budget or spending category.",
      amountHelp: "Expense amount.",
      notesHelp: "Receipt details or context.",
      transactionReceipt: "Transaction summary",
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
      clearAndSendReceipt: "Send transaction summary",
      clearAndSendReceiptDescription:
        "Creates a transaction summary and emails its private download link. It does not change bank reconciliation.",
      transaction: "Transaction",
      expenseOnlyError: "Receipts can only be sent for expense transactions.",
      alreadySentError: "Receipt delivery is not ready. Inspect the original workflow run and existing documents before retrying.",
      missingEmailError: "Add a receipt email address before processing this transaction.",
      sampleEmailError: "Replace the sample receipt email before sending a real receipt.",
      receiptSentSuccess: "Receipt ${{ inputs.transaction.Transaction reference }} sent.",
      chooseTransaction: "Choose transaction to process receipt",
      financeOverview: "Finance overview",
      spend: "Spend",
      budget: "Budget",
      spendByCategory: "Spend by category",
      expenseTransactionsOnly: "Expense transactions only",
      monthlySpend: "Monthly spend",
      processReceipt: "Send summary",
      logPurchaseTitle: "Log a purchase",
      monthlyIncome: "Monthly income",
      metricTotal: "Total",
    },
    de: {
      overview: "Dieser Monat",
      overviewHelp:
        "Einnahmen, Ausgaben und Budgets beziehen sich auf den aktuellen Kalendermonat. Erfasste Ausgaben zählen sofort, auch noch nicht abgeglichene Einträge. Dies ist ein privates Ausgabenbuch, kein Live-Kontostand.",
      activity: "Alle Transaktionen",
      review: "Zum Abgleichen",
      reviewHelp:
        "Vergleiche diese Einträge mit Kontoauszug oder Bargeldbestand. Öffne einen Eintrag, korrigiere ihn bei Bedarf und markiere ihn als abgeglichen. Es wird keine Bankverbindung hergestellt oder Zahlung ausgeführt.",
      noReview: "Alle erfassten Transaktionen sind abgeglichen.",
      noTransactions: "Noch keine Transaktionen. Erfasse eine Ausgabe oder Einnahme.",
      logIncome: "Einnahme erfassen",
      incomeLogged: "Einnahme erfasst.",
      editTransaction: "Transaktion bearbeiten",
      saveChanges: "Änderungen speichern",
      changesSaved: "Änderungen gespeichert.",
      plan: "Budgetplanung",
      budgetHelp:
        "Alle Beträge in EUR. Lege je Kategorie und Kalendermonat ein Budget an. Bearbeite vorhandene Budgets, statt ein zweites anzulegen: doppelte Limits werden in der Monatssumme addiert. Die Ausgaben des aktuellen Monats werden mit dem Limit verglichen; ein negativer Rest bedeutet eine Überschreitung. Umbuchungen und Einnahmen zählen nicht mit.",
      newBudget: "Budget festlegen",
      editBudget: "Budget bearbeiten",
      budgetSaved: "Budget gespeichert.",
      budgetHistory: "Budgetverlauf",
      remaining: "Verbleibend",
      spent: "Ausgegeben",
      currentBudgets: "Budgets dieses Monats",
      budgetSpendTotals: "Aktuelle Monatsausgaben nach Kategorie",
      budgetLimitTotals: "Aktuelle Monatsbudgets nach Kategorie",
      categoryTransactions: "Transaktionen der Kategorie ansehen",
      noBudgets: "Für diesen Monat gibt es noch kein Budget. Lege eines an, um Plan und Ausgaben zu vergleichen.",
      setup: "Konten & Kategorien",
      setupHelp:
        "Pflege hier die Konten und Kategorien für neue Transaktionen. Anfangssalden dienen als Referenz; diese App berechnet keine Kontostände und verwaltet keine zusammengehörigen Umbuchungen.",
      newAccount: "Konto hinzufügen",
      newCategory: "Kategorie hinzufügen",
      details: "Angaben",
      receiptHelp:
        "Optional: Versende eine druckbare Übersicht dieser Ausgabe. Sie ist nicht der Originalbeleg des Händlers. Hinterlege zuerst einen echten Empfänger. Der Versand gleicht die Transaktion nicht ab.",
      viewSummary: "Transaktionsübersicht",
      sendConfirm: "Diese Transaktionsübersicht an den gespeicherten Empfänger senden?",
      savedHelp: "Erfasse den Betrag positiv. Wähle Konto und Kategorie; Einnahmen und Ausgaben werden getrennt ausgewertet.",
      additional: "Optionale Angaben",
      editAccount: "Konto bearbeiten",
      editCategory: "Kategorie bearbeiten",
      templateName: "Private Finanzen",
      receiptJourney:
        "Prüfe die Transaktion und ersetze die Beispieladresse vor der Verarbeitung durch die gewünschte Empfängeradresse. Die Aktion erstellt eine Transaktionsübersicht und versendet sie per E-Mail; sie ruft weder den Originalbeleg des Händlers ab noch führt sie eine Zahlung aus. Erzeugte Dokumente erscheinen unten.",
      templateDescription: "Konten, Ausgaben, Budgets und Belegverarbeitung an einem Ort verwalten.",
      highlightRecords: "Transaktionen, Budgets und ein Ausgabenformular",
      highlightOverview: "Übersicht über Ausgaben, Budgets und Zahlungspartner",
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
      merchants: "Zahlungspartner",
      merchantNameDescription: "Name der Person, des Unternehmens oder Arbeitgebers.",
      defaultCategory: "Standardkategorie",
      defaultCategoryDescription: "Übliche Kategorie dieses Händlers; wähle die Kategorie beim Erfassen einer Transaktion.",
      website: "Website",
      merchantWebsiteDescription: "Händlerwebsite als Referenz für Transaktionen.",
      transactions: "Transaktionen",
      transactionReference: "Transaktionsreferenz",
      transactionReferenceDescription: "Automatisch erzeugte monatliche Referenz für diese Transaktion.",
      date: "Datum",
      transactionDateDescription: "Datum der Transaktion.",
      merchant: "Zahlungspartner",
      transactionMerchantDescription: "Von wem erhalten oder an wen gezahlt?",
      account: "Konto",
      transactionAccountDescription: "Konto, zu dem diese Transaktion gehört.",
      category: "Kategorie",
      transactionCategoryDescription: "Budget- oder Berichtskategorie dieser Transaktion.",
      merchantName: "Name des Zahlungspartners",
      merchantNameLookupDescription: "Aus dem verknüpften Händler übernommene Bezeichnung.",
      merchantWebsite: "Website des Zahlungspartners",
      merchantWebsiteLookupDescription: "Aus dem verknüpften Händler übernommene Website.",
      categoryName: "Kategoriename",
      categoryNameLookupDescription: "Aus der verknüpften Kategorie übernommene Bezeichnung.",
      type: "Typ",
      transactionTypeDescription: "Richtung der Transaktion für Einnahmen-, Ausgaben- oder Umbuchungsberichte.",
      transfer: "Umbuchung",
      amount: "Betrag",
      amountDescription: "Transaktionsbetrag in Euro.",
      cleared: "Abgeglichen",
      clearedDescription: "Mit Kontoauszug oder Bargeldbestand abgeglichen. Der Belegversand ändert diesen Status nicht.",
      notes: "Notizen",
      notesDescription: "Optionale Notizen zu dieser Transaktion.",
      receiptEmail: "E-Mail-Adresse für Beleg",
      receiptEmailDescription: "Optional. Nur zum Versenden einer Transaktionsübersicht erforderlich.",
      receiptSent: "Belegversand",
      receiptSentDescription:
        "Bereit, in Bearbeitung oder gesendet. Prüfe vor dem Zurücksetzen eines unterbrochenen Versands den ursprünglichen Lauf; die E-Mail könnte bereits gesendet worden sein.",
      deliveryReady: "Bereit",
      deliveryProcessing: "In Bearbeitung",
      deliverySent: "Gesendet",
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
      merchantHelp: "Person, Unternehmen oder Arbeitgeber.",
      merchantUrlHelp: "Optionale URL des Händlers.",
      accountHelp: "Konto oder Zahlungsquelle.",
      categoryHelp: "Budget- oder Ausgabenkategorie.",
      amountHelp: "Betrag der Ausgabe.",
      notesHelp: "Belegdetails oder weitere Hinweise.",
      transactionReceipt: "Transaktionsübersicht",
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
      clearAndSendReceipt: "Transaktionsübersicht senden",
      clearAndSendReceiptDescription:
        "Erstellt eine Transaktionsübersicht und versendet ihren privaten Download-Link. Der Kontenabgleich bleibt unverändert.",
      transaction: "Transaktion",
      expenseOnlyError: "Belege können nur für Ausgabentransaktionen gesendet werden.",
      alreadySentError:
        "Der Belegversand ist nicht bereit. Prüfe vor einem erneuten Versuch den ursprünglichen Workflow-Lauf und vorhandene Dokumente.",
      missingEmailError: "Füge eine E-Mail-Adresse für den Beleg hinzu, bevor du diese Transaktion verarbeitest.",
      sampleEmailError: "Ersetze die Beispieladresse, bevor du einen echten Beleg sendest.",
      receiptSentSuccess: "Beleg ${{ inputs.transaction.Transaktionsreferenz }} gesendet.",
      chooseTransaction: "Transaktion für die Belegverarbeitung auswählen",
      financeOverview: "Finanzübersicht",
      spend: "Ausgaben",
      budget: "Budget",
      spendByCategory: "Ausgaben nach Kategorie",
      expenseTransactionsOnly: "Nur Ausgabentransaktionen",
      monthlySpend: "Monatliche Ausgaben",
      processReceipt: "Übersicht senden",
      logPurchaseTitle: "Kauf erfassen",
      monthlyIncome: "Monatliche Einnahmen",
      metricTotal: "Summe",
    },
  },
});

export type FinanceText = ReturnType<typeof financeTemplateMessages.resolve>["t"];

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
    navigationGroups: [
      {
        name: t.transactions,
        entries: [
          { type: "customApp", key: "overview" },
          { type: "view", key: "recent_transactions" },
          { type: "form", key: "log_expense" },
          { type: "workflow", key: "send_receipt" },
          { type: "documentTemplate", key: "transaction_receipt" },
        ],
      },
      {
        name: t.budgets,
        entries: [
          { type: "view", key: "budgets" },
          { type: "table", key: "accounts" },
          { type: "table", key: "categories" },
        ],
      },
    ],
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
            defaultValue: { kind: "now" },
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
              min: "0.01",
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
            icon: "ti ti-mail",
            config: { regex: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
          },
          {
            key: "receipt_sent",
            name: t.receiptSent,
            description: t.receiptSentDescription,
            type: "select",
            required: true,
            config: {
              options: [
                { id: "ready", label: t.deliveryReady },
                { id: "processing", label: t.deliveryProcessing },
                { id: "sent", label: t.deliverySent },
              ],
            },
            icon: "ti ti-mail-check",
            defaultValue: ["ready"],
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
      ...financeBudgetViews(t),
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
        name: t.budgetHistory,
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
          field("budgets.month"),
          " desc",
        ),
      },
    ],
    forms: financeForms(t),
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
        key: "send_receipt",
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
      notEquals:
        - \${{ inputs.transaction.${t.receiptSent} }}
        - [ready]
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
  - atomicRecords:
      locks: [inputs.transaction]
      checks:
        - table: ${t.transactions}
          where:
            - field: ${t.transactionReference}
              op: equals
              value: \${{ inputs.transaction.${t.transactionReference} }}
            - field: ${t.receiptSent}
              op: is
              value: ready
            - field: ${t.type}
              op: is
              value: expense
          assert: notEmpty
          message: ${t.alreadySentError}
      changes:
        - updateRecord:
            record: inputs.transaction
            set:
              ${t.receiptSent}: [processing]
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
        ${t.receiptSent}: [sent]
  - succeed:
      message: "${t.receiptSentSuccess}"`,
        enabled: true,
      },
    ],
    workflowLaunchers: [
      {
        key: "send_receipt_custom_app",
        workflow: "send_receipt",
        name: t.chooseTransaction,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
    ],
    customApps: financeApp(t),
  };
};

export const financeTemplate: GridTemplate = createFinanceTemplate("en");
