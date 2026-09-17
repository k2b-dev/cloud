import type { DocumentTemplateRenderer } from "../contracts";
import { field, formula, table } from "./types";

/** Stable aliases decouple the mapping from localized field display names. */
export const billingDocumentSource = () => {
  const partyAliases = ["party"].flatMap((prefix) =>
    ["name", "vat_id", "street", "postal_code", "city", "iban", "account_name"].map((key) => `${prefix}_${key}`),
  );
  const aliases = [
    "kind",
    "invoice_date",
    "service_date",
    "due_date",
    "buyer_reference",
    "positions",
    "original_number",
    "original_company",
    "original_date",
    "reason",
    "agreement",
    ...partyAliases,
  ];
  return formula(
    "from table ",
    table("bills"),
    "\nleft join table ",
    table("bills"),
    " as original on ",
    field("bills.original"),
    " = original.id",
    "\nselect ",
    ...aliases.flatMap((alias, index) => [index ? ", " : "", field(`bills.${alias}`), ` as billing_${alias}`]),
    ...partyAliases.flatMap((alias) => [", original.", field(`bills.${alias}`), ` as billing_original_${alias}`]),
    "\nwhere record.id = '{{ record.id }}'\nlimit 1",
  );
};

const party = (prefix: "billing_party" | "billing_original_party") => `{
  "name": {{ bill.${prefix}_name | json }}, "vatId": {{ bill.${prefix}_vat_id | json }},
  "address": { "line1": {{ bill.${prefix}_street | json }}, "city": {{ bill.${prefix}_city | json }},
    "postalCode": {{ bill.${prefix}_postal_code | json }}, "countryCode": "DE" }
}`;
const company = `{
  "name": {{ company.legalName | json }}, "vatId": {{ company.vatId | json }},
  "address": { "line1": {{ company.address | json }}, "city": {{ company.city | json }},
    "postalCode": {{ company.postalCode | json }}, "countryCode": {{ company.countryCode | json }} }
}`;

export const billingDocumentRenderer: DocumentTemplateRenderer = {
  kind: "profile",
  id: "de.zugferd.en16931",
  version: 2,
  inputTemplate: `{% assign bill = rows | first %}
{% if bill.billing_kind contains 'creditNote' %}{% assign company = bill.billing_original_company %}{% else %}{% assign company = business %}{% endif %}
{
  "currency": "EUR",
  "invoiceDate": {{ bill.billing_invoice_date | slice: 0, 10 | json }},
  "serviceDate": {{ bill.billing_service_date | slice: 0, 10 | json }},
  "dueDate": {{ bill.billing_due_date | slice: 0, 10 | json }},
  "buyerReference": {{ bill.billing_buyer_reference | json }},
  "seller": {% if bill.billing_kind contains 'selfBilling' %}${party("billing_party")}{% else %}${company}{% endif %},
  "buyer": {% if bill.billing_kind contains 'selfBilling' %}${company}{% elsif bill.billing_kind contains 'creditNote' %}${party("billing_original_party")}{% else %}${party("billing_party")}{% endif %},
  "payment": {% if bill.billing_kind contains 'invoice' %}{ "iban": {{ company.iban | json }}, "accountName": {{ company.accountName | json }} }
    {% else %}{ "iban": {{ bill.billing_party_iban | json }}, "accountName": {{ bill.billing_party_account_name | json }} }{% endif %},
  "billing": {% if bill.billing_kind contains 'creditNote' %}{ "kind": "creditNote", "original": {
    "number": {{ bill.billing_original_number | json }}, "invoiceDate": {{ bill.billing_original_date | slice: 0, 10 | json }} }, "reason": {{ bill.billing_reason | json }} }
    {% elsif bill.billing_kind contains 'selfBilling' %}{ "kind": "selfBilling", "agreementReference": {{ bill.billing_agreement | json }} }
    {% else %}{ "kind": "invoice" }{% endif %},
  "lines": [{% for line in bill.billing_positions %}{% unless forloop.first %},{% endunless %}{
    "name": {{ line.Label1 | json }}, "quantity": {{ line.Qty001 | json }}, "unitPrice": {{ line.Price1 | json }},
    {% assign description = line.Detail | default: '' %}{% if description != blank %}"description": {{ description | json }},{% endif %}
    "unitCode": {{ line.Unit01 | first | json }},
    "taxRate": {% if line.Vat001 contains 'vat007' %}"7.00"{% else %}"19.00"{% endif %}
  }{% endfor %}]
}`,
};
