---
id: grids-build-business-app
title: Build a business app
icon: ti ti-building-store
description: Model inventory, loans, CRM, invoices, and expenses around the work people must complete.
order: 107
---
Start with one complete journey. Configuration requires Base Admin access. Templates are editable examples, not your business rules.

## Choose the records you need {icon="table"}

Every template includes Workflows, Document templates and a published Custom App. Bookshop Orders and Finance Transactions offer details, delivery and Documents; their create Forms open the new Record. Inventory shows agreements on Loans and labels on Items. Template updates affect new Bases only.

| Your task | Start with | First check |
| --- | --- | --- |
| List equipment | Items and Locations; Categories if needed | Each physical item has its own stable, unique code |
| Lend equipment | Items, Loans, and Loan positions | One position links one item to one loan and records its issue and return |
| Track customers and sales | Organisations, Contacts, Opportunities, and Activities | The responsible person and customer are clear |
| Issue invoices | Customers, Invoices, and Invoice lines | Quantity, price, tax, and customer facts match the intended invoice |
| Reimburse expenses | Claims, Claim lines, receipt Files, and payment references | The claimant, reviewed facts, and payment evidence are distinguishable |

An inventory list needs fields, records and Views; add loans for handovers and returns. Use generated or unique codes for business identities and Principals for Cloud people/groups. Customer Relations do not grant access.

For merchandise management, scope purchases, receipts, orders, shipments, partial returns and stock. Displayed totals do not reserve stock: stock-changing actions must prevent concurrent over-allocation. Grids is not a ready-made ERP, accounting system or payment integration.

## Build in dependency order {icon="route"}

:::steps
1. **Define decisions.** Specify actors, prerequisites, changes that must happen together, and completion criteria.
2. **Create tables and fields.** Add Relations after their target tables exist, then calculations. Use stored price and tax facts where later source changes must not alter the business record.
3. **Try records.** Include missing data, multiple lines and a rejected case.
4. **Add Forms and Workflows.** Forms collect input; actions enforce transitions such as issue, return, approve, and send. Keep transition fields out of ordinary App editing. Review **Table settings → Data integrity → Record changes** to control other write paths.
5. **Build the App.** Add a task list, Record details, create Form, actions and Documents. See **Build a Grids App**.
6. **Check access and publish.** Review the publish preflight and test the published journey with an account from each intended audience.
:::

Base Read exposes every record. Personal Views and hidden navigation do not isolate audiences. For narrower access, share Grids Apps with server-enforced queries and availability rules on lists, details, Forms and actions. Test another customer's copied opportunity URL; do not grant raw Base access to make a portal work.

Bind all required workflow inputs before publishing. Fixed launchers use stored bindings; `inputMode: prompt` requires App-supplied inputs, not a free-form dialog. Inventory's Add loan position row action binds `item` to `ROW.id` and `loan` to `RECORD.id`, avoiding a raw Base record picker.

## Make handovers and deliveries safe to repeat {icon="repeat"}

Create one loan position per item. Issue checks active loan, eligible position and available item, then stores that allocation. Return must match it: an old loan cannot return a newly lent item. Record damage before making items available. Close loans only after all positions finish.

Inventory supplies issue/return actions; inspect them before adapting. Add positions before approving a requested loan. Kits describe equipment, not enforced future reservations.

Use `atomicRecords` for bounded checks and changes that must succeed together. Separate update steps are not one transaction. Competing actions must coordinate on the same existing record. See **Workflows**.

Claim a ready delivery before generating documents or sending email. A retry key identifies one invocation; independent requests still need a shared business-state check. Complete delivery only after its steps finish. If stuck, inspect the original run, Documents and email delivery before retrying. Cancellation does not undo sent email or Documents.

## Preserve invoices {icon="file-invoice"}

Generated Documents keep their original snapshot and exact files. Editing sources does not rewrite them. Repeatable templates create another Document; once-per-finalized-record templates retrieve the existing one. Finalizing a header does not recursively finalize related lines. Object-list positions belong to the header and freeze with it. Keep later payments in separate records.

## Start with Billing {icon="file-invoice"}

The **Billing** template provides invoices, corrections and commission self-billing in EUR for distinct German business partners with German VAT IDs and 7% or 19% VAT. Other cases need a different model or renderer.

1. Ask a Base admin to complete **Base settings → Documents** with real company and bank details. Sample records are drafts.
2. Create an invoice, choose or create its partner, and enter Object-list positions. Check totals, service date and due date before issuing.
3. Choose **Issue invoice** on the saved document page. You can keep working while the PDF is created. After a rendering failure, choose **Continue creation**: it keeps the same Document, company details and number. `REF-…` is an internal reference, not the invoice number.
4. Record money actually received or paid out, then **Confirm payment**. Only confirmed payments affect balances; confirmation locks the payment. No bank transfer is executed.

**Open payments** groups overdue payments, payments due today or later, and credit balances to review. Open an amount due to record a payment. Credit balances open the original document for review. Only confirmed payments affect these lists.

Choose **Use as new invoice** on a finalized invoice to create a fresh draft with its recipient, buyer reference and positions. Check current partner details and prices, and choose new service and due dates. Payments, corrections, internal notes and issued files are not copied.

Partners receive a read-only customer number such as **KD-00001**, unique within the Base. Find it in the partner list, recipient selection, partner details and bill details. Renaming a partner keeps their number.

Prepare corrections from the original invoice; reduce copied positions for a partial correction. Checks preserve the remaining net and VAT at each rate. Self-billing needs an agreement reference and the recipient's bank account; enter positions directly and avoid settling the same obligation twice. **Discard draft** moves unfinished bills to Trash, not issued bills. Internal notes are not included in PDF/XML.

Corrections start with today's document date and no due date; review these before issuing. Record customer refunds with **Record refund** on the original invoice, using a positive amount. Confirmation subtracts the refund from received payments and rejects amounts above the current credit balance, including competing confirmations. A correction has no separate payment balance. Pending payments and refunds can be discarded; confirmed ones remain immutable.

HTML invoice starters are not E-Invoices. Check the installed renderer's currency, tax, address and correction scope and both output artifacts. The issuer remains responsible; validation is not tax or legal approval. Bookshop demonstrates invoices, not payment collection.

## Review expenses {icon="checklist"}

For expenses, fix the signed-in claimant in the Form instead of letting people choose another identity. Four-eyes Finalization requires a different person from the person who requested Finalization. It does not compare a separate claimant field: if someone submits on the claimant's behalf, you still need to enforce the no-self-approval rule for that claimant.

Review covers an exact Record version. Changes to its values, Relations or Files invalidate its pending request; related-line edits do not. Define the submission's records and receipt versions and require fresh review after changes. Header approval does not approve later line edits. See **Tables & fields** for access and permanent history/finalization settings.

A Paid checkbox transfers nothing. Payment execution needs a connected system, stable references and duplicate/uncertain-request handling. Investigate uncertain HTTP effects there before retrying. Finance tracks transactions and receipt delivery, not claimant/approver reimbursements.

## Verify the whole journey {icon="checklist"}

Test an empty list, a normal submission, a stale edit, and missing or inaccessible record IDs. Repeat the journey after reload and through a copied detail URL. Try two independent issue, send, or payment requests, and inspect an interrupted operation. For expenses, also test claimant self-approval and changed receipts or lines after review.

Record results, uncertainties, the App link, responsible operator and recovery steps. A valid draft does not prove isolation, safe retries or correct payments.

Continue with [Build a Grids App](/app/grids/help/grids-build-custom-app), [Workflows](/app/grids/help/grids-workflows), [Documents & PDFs](/app/grids/help/grids-documents-pdfs), and [Tables & fields](/app/grids/help/grids-tables-fields).
