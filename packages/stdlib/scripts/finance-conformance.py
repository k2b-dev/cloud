"""Independent XML/CSV/decimal checks; uses only Python's standard library."""
import csv
import io
import sys
import xml.etree.ElementTree as ET
from decimal import Decimal, ROUND_HALF_UP
from hashlib import sha256
from pathlib import Path

work = Path(sys.argv[1])
expected_failures = {
    "bad-payment-code": "BR-CL-16", "bad-payment-missing-code": "BR-49",
    "bad-payment-account": "BR-61", "bad-period-empty": "BR-CO-19",
    "bad-period-order": "BR-29", "bad-reference-id": "BR-55", "bad-K-date": "BR-IC-11",
    "bad-rounding-due": "BR-CO-16", "bad-rounding-scale": "BR-DEC-17",
    "bad-total": "BR-CO-15", "bad-tax": "BR-S-09",
    "bad-country": "BR-CL-14", "bad-vat": "BR-CO-09",
}
for category in ["E", "Z", "O", "AE", "K", "G"]:
    rule = "IC" if category == "K" else category
    for suffix, number in [("tax", "09"), ("basis", "08"), ("reason", "10")]:
        expected_failures[f"bad-{category}-{suffix}"] = f"BR-{rule}-{number}"
expected_failures.update({"bad-K-country": "BR-IC-12", "bad-O-rate": "BR-O-05",
                          "bad-AE-buyer": "BR-AE-02", "bad-K-buyer": "BR-IC-02"})
reports = list((work / "reports").glob("*.xml"))
assert len(reports) == len(list((work / "invoices").glob("*.xml"))), "Missing SVRL reports"
for path in reports:
    report = ET.parse(path)
    assert report.getroot().tag == "{http://purl.oclc.org/dsdl/svrl}schematron-output"
    failures = [node.attrib["id"] for node in report.findall(".//{*}failed-assert")]
    if path.stem in expected_failures:
        assert expected_failures[path.stem] in failures, (path.name, failures)
    else:
        assert not failures, (path.name, failures)

# Independent exact arithmetic over the emitted CII, without stdlib's reader/calculator.
for path in (work / "invoices").glob("*.xml"):
    if path.stem in expected_failures:
        continue
    invoice = ET.parse(path)
    groups = {}
    for line in invoice.findall(".//{*}IncludedSupplyChainTradeLineItem"):
        quantity = Decimal(line.findtext(".//{*}BilledQuantity"))
        price = Decimal(line.findtext(".//{*}ChargeAmount"))
        amount = (quantity * price).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        assert Decimal(line.findtext(".//{*}LineTotalAmount")) == amount
        category = line.findtext(".//{*}CategoryCode")
        rate = Decimal(line.findtext(".//{*}RateApplicablePercent", "0"))
        key = (category, rate)
        groups[key] = groups.get(key, Decimal(0)) + amount
    settlement = invoice.find(".//{*}ApplicableHeaderTradeSettlement")
    taxes = settlement.findall("{*}ApplicableTradeTax")
    assert len(taxes) == len(groups)
    tax_total = Decimal(0)
    for tax in taxes:
        category = tax.findtext("{*}CategoryCode")
        rate = Decimal(tax.findtext("{*}RateApplicablePercent", "0"))
        basis = groups[(category, rate)]
        amount = (basis * rate / 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        assert Decimal(tax.findtext("{*}BasisAmount")) == basis
        assert Decimal(tax.findtext("{*}CalculatedAmount")) == amount
        tax_total += amount
    totals = settlement.find("{*}SpecifiedTradeSettlementHeaderMonetarySummation")
    net = sum(groups.values())
    rounding = Decimal(totals.findtext("{*}RoundingAmount", "0.00"))
    for tag, expected in [("LineTotalAmount", net), ("TaxBasisTotalAmount", net), ("TaxTotalAmount", tax_total), ("GrandTotalAmount", net + tax_total), ("DuePayableAmount", net + tax_total + rounding)]:
        assert Decimal(totals.findtext("{*}" + tag)) == expected

# DK SCT subset: count/sum consistency, payment profile and placement, independently parsed.
def check_sepa(root):
    ns = {"s": "urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"}
    assert root.tag == "{" + ns["s"] + "}Document"
    message = root.find("s:CstmrCdtTrfInitn", ns)
    header = message.find("s:GrpHdr", ns)
    blocks = message.findall("s:PmtInf", ns)
    assert len(blocks) == 1
    block = blocks[0]
    rows = block.findall("s:CdtTrfTxInf", ns)
    assert len(rows) == 2
    amounts = [row.find("s:Amt/s:InstdAmt", ns) for row in rows]
    assert all(node.attrib == {"Ccy": "EUR"} for node in amounts)
    assert sum(Decimal(node.text) for node in amounts) == Decimal("12.31")
    for section in [header, block]:
        assert int(section.findtext("s:NbOfTxs", namespaces=ns)) == len(rows)
        assert Decimal(section.findtext("s:CtrlSum", namespaces=ns)) == Decimal("12.31")
    for path, value in [("s:PmtMtd", "TRF"), ("s:BtchBookg", "true"), ("s:PmtTpInf/s:SvcLvl/s:Cd", "SEPA"), ("s:ChrgBr", "SLEV"), ("s:ReqdExctnDt/s:Dt", "2026-09-14")]:
        assert block.findtext(path, namespaces=ns) == value
    assert rows[0].findtext("s:Cdtr/s:Nm", namespaces=ns) == "Recipient (Example)"
    assert rows[0].findtext("s:RmtInf/s:Ustrd", namespaces=ns) == "Example 'train' & meal"

sepa_xml = (work / "sepa.xml").read_text()
check_sepa(ET.fromstring(sepa_xml))
for damaged in [sepa_xml.replace("<CtrlSum>12.31", "<CtrlSum>12.30"), sepa_xml.replace("<NbOfTxs>2", "<NbOfTxs>3"), sepa_xml.replace("<ChrgBr>SLEV", "<ChrgBr>SHAR")]:
    assert damaged != sepa_xml
    try:
        check_sepa(ET.fromstring(damaged))
    except AssertionError:
        pass
    else:
        raise AssertionError("Independent SEPA checker accepted damaged output")

# CSV parsing is independent of the TypeScript writer. Compare reviewed golden bytes as well.
raw = (work / "datev.csv").read_bytes()
assert raw.startswith(b"\xef\xbb\xbf") and raw.endswith(b"\r\n")
assert b"\n" not in raw.replace(b"\r\n", b"")
records = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"), newline=""), delimiter=";", strict=True))
header, columns, *rows = records
assert len(header) == 31 and len(columns) == 125
# Exact headings from the official DATEV 700/13 sample, retrieved 2026-09-15.
assert sha256(";".join(columns).encode()).hexdigest() == "098f89c80237a74bfa03dd3e1f4bb5cf2ecc8157fb4ee373626bdd70a0966cf7"
assert header[:5] == ["EXTF", "700", "21", "Buchungsstapel", "13"]
assert header[10:16] == ["29098", "55003", "20260101", "4", "20260901", "20260930"]
assert header[18:22] == ["1", "0", "0", "EUR"]
assert len(rows) == 2 and all(len(row) == 125 for row in rows)
assert rows[0][0:3] == ["123,45", "S", "EUR"]
assert rows[0][6:11] == ["00440", "70000", "0009", "1109", "RE-2026-1"]
assert rows[0][13] == 'Office; "rent"'
assert rows[1][0:3] == ["3,00", "H", "EUR"]
assert all(row[113] == "0" for row in rows)
golden = Path(__file__).parent.parent / "examples/fixtures/datev/booking-batch.csv"
assert raw == golden.read_bytes(), "DATEV golden bytes changed; review against the format specification"
# DATEV XML-Schnittstelle online: ZIP structure and ledger consistency, checked with zipfile and ElementTree only.
def check_datev_xml(path):
    import zipfile
    doc_ns = "{http://xml.datev.de/bedi/tps/document/v06.0}"
    ledger_ns = "{http://xml.datev.de/bedi/tps/ledger/v060}"
    xsi_type = "{http://www.w3.org/2001/XMLSchema-instance}type"
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        infos = archive.infolist()
        names = [info.filename for info in infos]
        assert names[0] == "document.xml" and len(set(n.lower() for n in names)) == len(names)
        assert all(n.isascii() and "/" not in n and "\\" not in n for n in names)
        assert all(info.compress_type == zipfile.ZIP_STORED and info.flag_bits == 0 for info in infos)
        root = ET.fromstring(archive.read("document.xml"))
        assert root.tag == doc_ns + "archive" and root.attrib["version"] == "6.0"
        documents = root.findall(f"{doc_ns}content/{doc_ns}document")
        assert 1 <= len(documents) <= 4999
        referenced = ["document.xml"]
        for document in documents:
            extensions = document.findall(f"{doc_ns}extension")
            ledger, *files = extensions
            kind = ledger.attrib[xsi_type]
            assert kind in ("accountsPayableLedger", "accountsReceivableLedger", "cashLedger")
            assert all(f.attrib[xsi_type] == "File" for f in files) and len(files) <= 49
            properties = {p.attrib["key"]: p.attrib["value"] for p in ledger.findall(f"{doc_ns}property")}
            assert properties.keys() in ({"1", "2"}, {"1", "3"}) if kind == "cashLedger" else properties.keys() == {"1", "3"}
            referenced += [ledger.attrib["datafile"], *[f.attrib["name"] for f in files]]
            data = ET.fromstring(archive.read(ledger.attrib["datafile"]))
            assert data.tag == ledger_ns + "LedgerImport"
            assert data.attrib["xml_data"] == "Kopie nur zur Verbuchung berechtigt nicht zum Vorsteuerabzug"
            consolidate = data.find(f"{ledger_ns}consolidate")
            rows = list(consolidate)
            assert 1 <= len(rows) <= 5000 and all(row.tag == ledger_ns + kind for row in rows)
            amounts = [Decimal(row.findtext(f"{ledger_ns}amount")) for row in rows]
            assert all(amount != 0 and amount == amount.quantize(Decimal("0.01")) for amount in amounts)
            assert Decimal(consolidate.attrib["consolidatedAmount"]) == sum(amounts)
            assert all(row.findtext(f"{ledger_ns}date") == consolidate.attrib["consolidatedDate"] for row in rows)
            assert consolidate.attrib["consolidatedDate"].startswith(properties["1"] + "-")
            assert all(row.findtext(f"{ledger_ns}currencyCode") == consolidate.attrib["consolidatedCurrencyCode"] == "EUR" for row in rows)
            if kind != "cashLedger":
                assert len({amount < 0 for amount in amounts}) == 1
                assert all(row.findtext(f"{ledger_ns}invoiceId") == consolidate.attrib["consolidatedInvoiceId"] for row in rows)
                delivery = consolidate.attrib.get("consolidatedDeliveryDate")
                assert all(row.findtext(f"{ledger_ns}deliveryDate") == delivery for row in rows)
            else:
                assert all(1 <= len(row.findtext(f"{ledger_ns}bookingText")) <= 30 for row in rows)
        assert sorted(referenced) == sorted(names), "ZIP entries and document.xml references differ"

for path in sorted(work.glob("datev-xml-*.zip")):
    check_datev_xml(path)
print(f"Finance conformance: {len(reports)} Schematron cases, SEPA profile, DATEV golden and DATEV XML packages passed")
