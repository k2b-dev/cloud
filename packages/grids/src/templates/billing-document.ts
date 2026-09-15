import type { DocumentTemplateRenderer } from "../contracts";
import { field, formula, table } from "./types";

/** Stable aliases decouple the mapping from localized field display names. */
export const billingDocumentSource = () => {
  const partyAliases = ["settings", "party"].flatMap((prefix) =>
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

const party = (variable: "seller" | "buyer") => `{
  "name": {{ bill[${variable}_name] | json }}, "vatId": {{ bill[${variable}_vat] | json }},
  "address": { "line1": {{ bill[${variable}_street] | json }}, "city": {{ bill[${variable}_city] | json }},
    "postalCode": {{ bill[${variable}_postal] | json }}, "countryCode": "DE" }
}`;

export const billingDocumentRenderer: DocumentTemplateRenderer = {
  kind: "profile",
  id: "de.zugferd.en16931",
  version: 2,
  inputTemplate: `{% assign bill = rows | first %}
{% if bill.billing_kind contains 'selfBilling' %}{% assign seller = 'billing_party' %}{% assign buyer = 'billing_settings' %}
{% elsif bill.billing_kind contains 'creditNote' %}{% assign seller = 'billing_original_settings' %}{% assign buyer = 'billing_original_party' %}
{% else %}{% assign seller = 'billing_settings' %}{% assign buyer = 'billing_party' %}{% endif %}
{% assign seller_name = seller | append: '_name' %}{% assign seller_vat = seller | append: '_vat_id' %}
{% assign seller_street = seller | append: '_street' %}{% assign seller_city = seller | append: '_city' %}{% assign seller_postal = seller | append: '_postal_code' %}
{% assign buyer_name = buyer | append: '_name' %}{% assign buyer_vat = buyer | append: '_vat_id' %}
{% assign buyer_street = buyer | append: '_street' %}{% assign buyer_city = buyer | append: '_city' %}{% assign buyer_postal = buyer | append: '_postal_code' %}
{% if bill.billing_kind contains 'creditNote' %}{% assign payee = 'billing_party' %}{% else %}{% assign payee = seller %}{% endif %}
{% assign bank = payee | append: '_iban' %}{% assign holder = payee | append: '_account_name' %}
{
  "currency": "EUR",
  "invoiceDate": {{ bill.billing_invoice_date | slice: 0, 10 | json }},
  "serviceDate": {{ bill.billing_service_date | slice: 0, 10 | json }},
  "dueDate": {{ bill.billing_due_date | slice: 0, 10 | json }},
  "buyerReference": {{ bill.billing_buyer_reference | json }},
  "seller": ${party("seller")}, "buyer": ${party("buyer")},
  "payment": { "iban": {{ bill[bank] | json }}, "accountName": {{ bill[holder] | json }} },
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
