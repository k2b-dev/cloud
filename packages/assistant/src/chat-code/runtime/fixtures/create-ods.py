"""Generate independent ODF 1.3 reader fixtures using only Python's standard library."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).parent


def write(name, tables):
    content = f'''<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" office:version="1.3">
 <office:body><office:spreadsheet>{tables}</office:spreadsheet></office:body>
</office:document-content>'''
    manifest = '''<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>'''
    with ZipFile(ROOT / name, "w") as archive:
        for path, text in [
            ("mimetype", "application/vnd.oasis.opendocument.spreadsheet"),
            ("content.xml", content), ("META-INF/manifest.xml", manifest),
        ]:
            info = ZipInfo(path, (2026, 1, 1, 0, 0, 0))
            if path != "mimetype":
                info.compress_type = ZIP_DEFLATED
            archive.writestr(info, text)


write("ledger.ods", '''
<table:table table:name="Ledger">
 <table:table-header-rows><table:table-row>
  <table:table-cell office:value-type="string"><text:p>Reference</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Amount</text:p></table:table-cell>
 </table:table-row></table:table-header-rows>
 <table:table-row-group><table:table-row-group><table:table-rows>
  <table:table-row table:number-rows-repeated="2">
   <table:table-cell office:value-type="string"><text:p>Müller &amp; Söhne</text:p></table:table-cell>
   <table:table-cell office:value-type="currency" office:currency="EUR" office:value="12.34"/>
  </table:table-row>
 </table:table-rows></table:table-row-group></table:table-row-group>
 <table:table-row table:number-rows-repeated="2"><table:table-cell/></table:table-row>
 <table:table-row>
  <table:table-cell office:value-type="string"><text:p>Cached formula</text:p></table:table-cell>
  <table:table-cell office:value-type="float" office:value="24.68" table:formula="of:=SUM([.B2:.B3])"/>
 </table:table-row>
 <table:table-row>
  <table:table-cell office:value-type="string"><text:p>No cache</text:p></table:table-cell>
  <table:table-cell table:formula="of:=1+1"/>
 </table:table-row>
</table:table>
<table:table table:name="Types">
 <table:table-row>
  <table:table-cell office:value-type="boolean" office:boolean-value="true"/>
  <table:table-cell office:value-type="boolean" office:boolean-value="false"/>
  <table:table-cell office:value-type="date" office:date-value="2026-09-20"/>
  <table:table-cell office:value-type="percentage" office:value="0.25"/>
  <table:table-cell table:number-columns-repeated="2"/>
  <table:table-cell office:value-type="float" office:value="7" table:number-columns-repeated="2"/>
  <table:table-cell office:value-type="time" office:time-value="PT1H30M"/>
 </table:table-row>
 <table:table-row>
  <table:table-cell office:value-type="string" table:number-columns-spanned="2"><text:p>Merged</text:p></table:table-cell>
  <table:covered-table-cell/>
  <table:table-cell office:value-type="string"><text:p>Line 1</text:p><text:p>Line<text:s text:c="2"/>2</text:p></table:table-cell>
 </table:table-row>
</table:table>
<table:table table:name="Empty"/>
''')

# Tiny compressed input that must fail the reader's expanded-cell budget.
write("repeated.ods", '''<table:table table:name="Repeated">
 <table:table-row table:number-rows-repeated="1000000">
  <table:table-cell office:value-type="float" office:value="1" table:number-columns-repeated="1000"/>
 </table:table-row>
</table:table>''')
