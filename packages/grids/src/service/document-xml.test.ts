import { expect, test } from "bun:test";
import { DOMParser, onWarningStopParsing } from "@xmldom/xmldom";
import { renderDocumentXml, validateDocumentXml, validateDocumentXmlTemplate } from "./document-xml";

test("XML loops preserve exact values and escape text and both attribute quote styles", () => {
  const value = 'Müller & Söhne 😀 <tag a="x">&\'\t\n';
  const result = renderDocumentXml(
    '<?xml version="1.0" encoding="UTF-8"?><report xmlns="urn:report">{% for row in rows %}<entry name="{{ row.name }}" other=\'{{ row.name }}\'><amount>{{ row.amount }}</amount><label>{{ row.name }}</label></entry>{% endfor %}</report>',
    {
      rows: [
        { name: value, amount: "12.30" },
        { name: "Second", amount: "42.00" },
      ],
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  const parsed = new DOMParser({ onError: onWarningStopParsing }).parseFromString(result.data, "application/xml");
  const entries = parsed.getElementsByTagName("entry");
  expect(entries.length).toBe(2);
  expect(entries.item(0)?.getAttribute("name")).toBe(value);
  expect(entries.item(0)?.getAttribute("other")).toBe(value);
  expect(parsed.getElementsByTagName("amount").item(0)?.textContent).toBe("12.30");
  expect(parsed.getElementsByTagName("label").item(0)?.textContent).toBe(value);
  expect(result.data).not.toContain("<tag");
});

test("XML interpolation cannot change names, namespaces, declarations or markup contexts", () => {
  for (const body of [
    "<{{ document.number }}/>",
    '<root {{ document.number }}="x"/>',
    '<root xmlns="{{ document.number }}"/>',
    '<root xmlns:x="{{ document.number }}"/>',
    '<root name={% if true %}"x"{% endif %}/>',
    "<root name={{ document.number }}/>",
    "<root><!-- {{ document.number }} --></root>",
    "<root><![CDATA[{{ document.number }}]]></root>",
    '<?xml version="{{ document.number }}"?><root/>',
    '<!DOCTYPE root SYSTEM "https://example.invalid/dtd"><root/>',
    "{% capture markup %}<root/>{% endcapture %}{{ markup }}",
    "{% raw %}<root/>{% endraw %}",
    "<root>{{ record.id }}</root>",
  ])
    expect(validateDocumentXmlTemplate(body).ok).toBe(false);
});

test("XML parsing fails closed on malformed output, namespaces, entities and illegal characters", () => {
  for (const xml of [
    "<a/><b/>",
    "<a>",
    "<x:a/>",
    '<a x="1" x="2"/>',
    "<a>&unknown;</a>",
    "<a>&#0;</a>",
    "<a>&#xD800;</a>",
    "<a>&#1114112;</a>",
    "<a>\u0001</a>",
    "<a>\ud800</a>",
    '<?xml version="1.1"?><a/>',
    '<?xml version="1.0" encoding="UTF-16"?><a/>',
    '<!DOCTYPE a [<!ENTITY x "hello">]><a>&x;</a>',
    "<a></a\njunk>",
  ])
    expect(validateDocumentXml(xml).ok).toBe(false);
  expect(renderDocumentXml("<root>{{ document.number }}</root>", { document: { number: "\u0001" } }).ok).toBe(false);
});

test("empty results, conditions, static namespaces and escaped entity-looking values are supported", () => {
  const result = renderDocumentXml('<r:root xmlns:r="urn:r">{% for row in rows %}<r:item>{{ row }}</r:item>{% endfor %}</r:root>', {
    rows: [],
  });
  expect(result).toEqual({ ok: true, data: '<r:root xmlns:r="urn:r"></r:root>' });
  expect(
    renderDocumentXml("<root>{% if document.number %}{{ document.number }}{% endif %}</root>", { document: { number: "&#0;" } }),
  ).toEqual({ ok: true, data: "<root>&amp;#0;</root>" });
});
