import type { FinanceText } from "./finance";
import { field, type GridTemplate } from "./types";

export const financeForms = (t: FinanceText): NonNullable<GridTemplate["forms"]> => {
  const transactionInputs = (creating: boolean) => [
    { kind: "user_input", fieldId: field("transactions.amount"), required: true, width: "compact" },
    {
      kind: "user_input",
      fieldId: field("transactions.date"),
      required: true,
      width: "compact",
      ...(creating ? { defaultValue: { kind: "now" } } : {}),
    },
    {
      kind: "user_input",
      fieldId: field("transactions.merchant"),
      required: true,
      inlineCreate: { enabled: true, fields: [{ fieldId: field("merchants.name"), required: true }] },
    },
    { kind: "user_input", fieldId: field("transactions.account"), required: true, width: "compact" },
    { kind: "user_input", fieldId: field("transactions.category"), required: true, width: "compact" },
  ];
  const optionalInputs = [
    { kind: "user_input", fieldId: field("transactions.notes"), section: { title: t.additional, collapsible: true } },
    { kind: "user_input", fieldId: field("transactions.receipt_email"), helpText: t.receiptEmailDescription },
  ];
  return [
    ...(["expense", "income"] as const).map((kind) => ({
      key: `log_${kind}`,
      table: "transactions",
      name: kind === "expense" ? t.logExpense : t.logIncome,
      config: {
        title: kind === "expense" ? t.logExpense : t.logIncome,
        description: t.savedHelp,
        submitLabel: kind === "expense" ? t.logExpense : t.logIncome,
        successMessage: kind === "expense" ? t.expenseLogged : t.incomeLogged,
        fields: [
          ...transactionInputs(true),
          ...(kind === "expense" ? optionalInputs : optionalInputs.slice(0, 1)),
          { kind: "form_value", fieldId: field("transactions.type"), value: [kind] },
          { kind: "form_value", fieldId: field("transactions.cleared"), value: false },
          { kind: "form_value", fieldId: field("transactions.receipt_sent"), value: ["ready"] },
        ],
      },
    })),
    {
      key: "edit_transaction",
      table: "transactions",
      name: t.editTransaction,
      config: {
        title: t.editTransaction,
        description: t.savedHelp,
        submitLabel: t.saveChanges,
        successMessage: t.changesSaved,
        fields: [
          ...transactionInputs(false),
          { kind: "user_input", fieldId: field("transactions.type"), required: true, width: "compact" },
          { kind: "user_input", fieldId: field("transactions.cleared"), helpText: t.clearedDescription, width: "compact" },
          ...optionalInputs,
        ],
      },
    },
    {
      key: "budget",
      table: "budgets",
      name: t.newBudget,
      config: {
        title: t.budget,
        description: t.budgetHelp,
        submitLabel: t.saveChanges,
        successMessage: t.budgetSaved,
        fields: [
          { kind: "user_input", fieldId: field("budgets.category"), required: true },
          { kind: "user_input", fieldId: field("budgets.month"), required: true, width: "compact" },
          { kind: "user_input", fieldId: field("budgets.limit"), required: true, width: "compact" },
        ],
      },
    },
    ...(["accounts", "categories"] as const).map((tableKey) => ({
      key: tableKey,
      table: tableKey,
      name: tableKey === "accounts" ? t.newAccount : t.newCategory,
      config: {
        submitLabel: t.saveChanges,
        successMessage: t.changesSaved,
        fields: ["name", "kind", ...(tableKey === "accounts" ? ["opening_balance"] : ["fixed"])].map((key) => ({
          kind: "user_input",
          fieldId: field(`${tableKey}.${key}`),
          ...(key === "name" ? { required: true } : { width: "compact" }),
        })),
      },
    })),
  ];
};
