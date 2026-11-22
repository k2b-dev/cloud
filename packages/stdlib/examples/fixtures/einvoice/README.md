# Independent compatibility fixture

`cloud-factur-x-1.2.0.xml` was generated on 2026-09-15 by Cloud's existing
`buildGermanEInvoiceXml` with its installed `@stackforge-eu/factur-x@1.2.0`.
The data is synthetic: two positions of EUR 100.00 at 19% and EUR 20.00 at 7%,
with a total of EUR 140.40. It is retained as an independent parser fixture;
stdlib did not generate it. The legacy profile uses the invoice date as the
service date and defaults positions to unit C62.
