---
id: grids-build-business-app
title: Build a business app
icon: ti ti-building-store
description: Model inventory, loans, CRM, invoices, and expenses around the work people must complete.
order: 107
---
Build one complete journey before adding reports or more automation. You need Base Admin access to configure the resources. A template supplies editable examples; it does not establish your business rules.

## Choose the records you need {icon="table"}

Every built-in template includes Workflows, Document templates and at least one published Custom App. In Bookshop and Finance, open an Order or Transaction row to review its details, run the delivery action and find generated Documents. Their create Forms also open the new Record's detail page. Inventory shows loan agreements on Loan details and generated labels on Item details. These improvements apply to newly created Bases; existing Bases are not changed by template updates.

| Your task | Start with | First check |
| --- | --- | --- |
| List equipment | Items and Locations; Categories if needed | Each physical item has its own stable, unique code |
| Lend equipment | Items, Loans, and Loan positions | One position links one item to one loan and records its issue and return |
| Track customers and sales | Organisations, Contacts, Opportunities, and Activities | The responsible person and customer are clear |
| Issue invoices | Customers, Invoices, and Invoice lines | Quantity, price, tax, and customer facts match the intended invoice |
| Reimburse expenses | Claims, Claim lines, receipt Files, and payment references | The claimant, reviewed facts, and payment evidence are distinguishable |

For a simple inventory list, stop after fields, representative records, and useful Views. Add loans only when you need handovers and returns. Use a generated or unique code for a business identity and a Principal for a Cloud person or group. A customer Relation does not grant that customer access.

For merchandise management, first choose which purchases, receipts, orders, shipments, partial returns, and stock quantities you will manage. A displayed stock total does not reserve stock. Do not promise that concurrent picks cannot over-allocate until the stock-changing actions enforce that rule. Grids is not a ready-made ERP, accounting system, or payment integration.

## Build in dependency order {icon="route"}

:::steps
1. **Define the decisions.** For each action, write who may run it, the current facts it requires, what changes together, and how you recognize completion.
2. **Create tables and fields.** Add Relations after their target tables exist, then calculations. Use stored price and tax facts where later source changes must not alter the business record.
3. **Try representative records.** Include missing data, more than one line, and a record that must be rejected.
4. **Add Forms and Workflows.** Forms collect input; actions enforce transitions such as issue, return, approve, and send. Keep transition fields out of ordinary App editing. Review **Table settings → Data integrity → Record changes** to control other write paths.
5. **Build the audience's App.** Provide a task list, a Record detail page, a create Form, and the relevant actions and Documents. Follow **Build a Grids App** for page setup.
6. **Check access and publish.** Review the publish preflight and test the published journey with an account from each intended audience.
:::

Base Read exposes every record in the Base. Personal Views and hidden navigation do not isolate customers or employees. Share separate Grids Apps when audiences need narrower access, and use server-enforced queries and availability rules on lists, detail pages, Forms, and actions. For a CRM portal, test a copied opportunity URL belonging to another customer. Do not give raw Base access merely to make the portal work.

Bind every required workflow input before publishing an App action. A fixed launcher supplies its stored bindings; with `inputMode: prompt`, the App action must supply the required inputs. This mode does not open a free-form input dialog in the App. For example, the Inventory loan page lists available items and offers an Add loan position row action: it binds `item` to `ROW.id` and `loan` to the page's `RECORD.id`. The selected row supplies the item without giving the reader a raw Base record picker.

## Make handovers and deliveries safe to repeat {icon="repeat"}

For equipment loans, create a position for each item. Issue must check that the loan is active, the position is eligible, and the item is available, then record the position as that item's current allocation. Return must check that exact allocation before clearing it. An old loan must never return an item issued under a newer loan. Record the return condition so damaged items do not become available. Close a loan only when its positions are finished.

The Inventory template supplies position-based issue and return actions. Add positions while the loan is still requested, before approving it. Inspect the actions before adapting them. Kits describe requested equipment; they do not enforce future date-range reservations.

When two people can run the same action, its checks and related record changes must succeed together. Workflows provide `atomicRecords` for bounded record changes; several ordinary update steps are not one transaction. Competing actions must coordinate on the same existing record. See **Workflows** for authoring details.

Before document generation or email, an action should claim a delivery that is ready and mark it in progress. Only that operation proceeds. A retry key identifies one invocation; two independently started requests still need the same business-state check. Mark delivery complete only after its steps complete. If it remains in progress, inspect the original run, Documents, and email delivery before trying again. Cancellation does not undo an email or a generated Document.

## Preserve invoices and review expenses {icon="file-invoice"}

Generated Documents keep their original snapshot and exact files. Editing source records does not rewrite an issued Document; generating again creates another Document. If the source records must also be locked, configure Finalization for them. Finalizing an invoice header does not recursively finalize its line records. Keep delivery and payment updates in separate operational records when the invoice itself is finalized.

An HTML invoice starter is not an E-Invoice. Select an installed E-Invoice renderer and check its supported currency, tax, address, and correction cases before using it. Inspect both the readable document and its structured artifact. The invoice issuer remains responsible for its content; technical validation is not tax or legal approval. The Bookshop template is an invoice example, not payment collection.

For expenses, fix the signed-in claimant in the Form instead of letting people choose another identity. Four-eyes Finalization requires a different person from the person who requested Finalization. It does not compare a separate claimant field: if someone submits on the claimant's behalf, you still need to enforce the no-self-approval rule for that claimant.

Review applies to the exact Record version. Changes to that Record's values, Relations, or attached Files invalidate its pending request. Editing a related line record is not the same as editing the reviewed Record. Decide which records and receipt versions constitute the submission and ensure a changed submission requires a new review. Do not treat a header approval as approval of later line edits. See **Tables & fields** for access requirements and permanent history and finalization settings.

A Paid checkbox does not transfer money. Payment execution requires an explicitly connected payment system, a stable payment reference, and verified handling of duplicate or uncertain requests. An uncertain HTTP effect needs investigation with that system before another attempt. The Finance template tracks transactions and receipt delivery; it is not a claimant/approver reimbursement process.

## Verify the whole journey {icon="checklist"}

Test an empty list, a normal submission, a stale edit, and missing or inaccessible record IDs. Repeat the journey after reload and through a copied detail URL. Try two independent issue, send, or payment requests, and inspect an interrupted operation. For expenses, also test claimant self-approval and changed receipts or lines after review.

Record what passed and what remains unverified. Keep the App link, the responsible operator, and recovery instructions with the process. A valid App draft alone does not prove isolation, safe retries, or correct payments.

Continue with [Build a Grids App](/app/grids/help/grids-build-custom-app), [Workflows](/app/grids/help/grids-workflows), [Documents & PDFs](/app/grids/help/grids-documents-pdfs), and [Tables & fields](/app/grids/help/grids-tables-fields).
