type BarcodeOption = { id: string; label: string; description: string; icon: string; groups?: readonly string[] };

export const BARCODE_GROUPS = [
  { value: "recommended", label: "Recommended" },
  { value: "linear", label: "Linear" },
  { value: "2d", label: "2D" },
  { value: "gs1-retail", label: "GS1 & retail" },
  { value: "postal", label: "Postal" },
  { value: "healthcare", label: "Healthcare" },
  { value: "publishing", label: "Publishing" },
] as const;

const CURATED_BARCODE_OPTIONS: BarcodeOption[] = [
  { id: "code128", label: "Code 128", description: "General-purpose linear barcode.", icon: "ti ti-barcode" },
  { id: "qrcode", label: "QR Code", description: "Compact 2D code for phones.", icon: "ti ti-qrcode" },
  { id: "datamatrix", label: "Data Matrix", description: "Small 2D code for labels.", icon: "ti ti-grid-dots" },
  { id: "pdf417", label: "PDF417", description: "Stacked 2D code for documents.", icon: "ti ti-barcode" },
  { id: "azteccode", label: "Aztec Code", description: "Dense 2D code without quiet zone.", icon: "ti ti-qrcode" },
  { id: "ean13", label: "EAN-13", description: "Retail product code, 13 digits.", icon: "ti ti-barcode" },
  { id: "ean8", label: "EAN-8", description: "Short retail product code.", icon: "ti ti-barcode" },
  { id: "upca", label: "UPC-A", description: "US retail product code.", icon: "ti ti-barcode" },
  { id: "upce", label: "UPC-E", description: "Compressed UPC code.", icon: "ti ti-barcode" },
  { id: "itf14", label: "ITF-14", description: "Carton and package code.", icon: "ti ti-barcode" },
  { id: "gs1datamatrix", label: "GS1 Data Matrix", description: "GS1 2D code with application IDs.", icon: "ti ti-grid-dots" },
  { id: "sscc18", label: "SSCC-18", description: "Shipping container code.", icon: "ti ti-barcode" },
  { id: "isbn", label: "ISBN", description: "Book identifier barcode.", icon: "ti ti-barcode" },
  { id: "issn", label: "ISSN", description: "Serial publication barcode.", icon: "ti ti-barcode" },
  { id: "ismn", label: "ISMN", description: "Printed music barcode.", icon: "ti ti-barcode" },
  { id: "code39", label: "Code 39", description: "Simple alphanumeric barcode.", icon: "ti ti-barcode" },
  { id: "code93", label: "Code 93", description: "Compact alphanumeric barcode.", icon: "ti ti-barcode" },
  { id: "interleaved2of5", label: "Interleaved 2 of 5", description: "Numeric warehouse barcode.", icon: "ti ti-barcode" },
  { id: "micropdf417", label: "MicroPDF417", description: "Compact stacked 2D code.", icon: "ti ti-barcode" },
  { id: "microqrcode", label: "Micro QR Code", description: "Tiny QR variant.", icon: "ti ti-qrcode" },
  { id: "maxicode", label: "MaxiCode", description: "Parcel and logistics 2D code.", icon: "ti ti-grid-dots" },
  { id: "dotcode", label: "DotCode", description: "Dot-based production code.", icon: "ti ti-grid-dots" },
];

const BARCODE_SYMBOL_IDS: string[] = [
  "auspost",
  "azteccode",
  "azteccodecompact",
  "aztecrune",
  "bc412",
  "channelcode",
  "codablockf",
  "code11",
  "code128",
  "code16k",
  "code2of5",
  "code32",
  "code39",
  "code39ext",
  "code49",
  "code93",
  "code93ext",
  "codeone",
  "coop2of5",
  "d3aqr",
  "daft",
  "databarexpanded",
  "databarexpandedcomposite",
  "databarexpandedstacked",
  "databarexpandedstackedcomposite",
  "databarlimited",
  "databarlimitedcomposite",
  "databaromni",
  "databaromnicomposite",
  "databarstacked",
  "databarstackedcomposite",
  "databarstackedomni",
  "databarstackedomnicomposite",
  "databartruncated",
  "databartruncatedcomposite",
  "datalogic2of5",
  "datamatrix",
  "datamatrixrectangular",
  "datamatrixrectangularextension",
  "dotcode",
  "ean13",
  "ean13composite",
  "ean14",
  "ean2",
  "ean5",
  "ean8",
  "ean8composite",
  "flattermarken",
  "gs1datamatrix",
  "gs1datamatrixrectangular",
  "gs1dldatamatrix",
  "gs1dlqrcode",
  "gs1dotcode",
  "gs1northamericancoupon",
  "gs1qrcode",
  "hanxin",
  "hibcazteccode",
  "hibccodablockf",
  "hibccode128",
  "hibccode39",
  "hibcdatamatrix",
  "hibcdatamatrixrectangular",
  "hibcmicropdf417",
  "hibcpdf417",
  "hibcqrcode",
  "iata2of5",
  "identcode",
  "industrial2of5",
  "isbn",
  "ismn",
  "issn",
  "itf14",
  "japanpost",
  "kix",
  "leitcode",
  "mailmark",
  "mands",
  "matrix2of5",
  "maxicode",
  "micropdf417",
  "microqrcode",
  "msi",
  "onecode",
  "pdf417",
  "pdf417compact",
  "pharmacode2",
  "pharmacode",
  "planet",
  "plessey",
  "posicode",
  "postnet",
  "pzn",
  "qrcode",
  "rectangularmicroqrcode",
  "royalmail",
  "sscc18",
  "swissqrcode",
  "symbol",
  "telepen",
  "telepennumeric",
  "ultracode",
  "upca",
  "upcacomposite",
  "upce",
  "upcecomposite",
];

export const DEFAULT_BARCODE_BCID = "code128";

const curatedById = new Map(CURATED_BARCODE_OPTIONS.map((option) => [option.id, option]));
const curatedIds = new Set(curatedById.keys());

const includesAny = (id: string, fragments: readonly string[]) => fragments.some((fragment) => id.includes(fragment));

export const barcodeGroups = (id: string): readonly string[] => {
  const groups: string[] = [];
  if (curatedIds.has(id)) groups.push("recommended");

  const is2d = includesAny(id, [
    "aztec",
    "codablock",
    "code16k",
    "code49",
    "codeone",
    "composite",
    "d3aqr",
    "datamatrix",
    "dotcode",
    "hanxin",
    "maxicode",
    "pdf417",
    "qrcode",
    "ultracode",
  ]);
  groups.push(is2d ? "2d" : "linear");

  if (includesAny(id, ["databar", "ean", "gs1", "isbn", "ismn", "issn", "itf14", "sscc", "upc"])) {
    groups.push("gs1-retail");
  }
  if (
    includesAny(id, [
      "auspost",
      "daft",
      "flattermarken",
      "identcode",
      "japanpost",
      "kix",
      "leitcode",
      "mailmark",
      "onecode",
      "planet",
      "postnet",
      "royalmail",
    ])
  ) {
    groups.push("postal");
  }
  if (includesAny(id, ["code32", "hibc", "pharmacode", "pzn"])) groups.push("healthcare");
  if (includesAny(id, ["isbn", "ismn", "issn"])) groups.push("publishing");
  return groups;
};

const advancedLabel = (id: string) => id.replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2");

export const barcodeSelectedLabel = (id: string | undefined): string | undefined => {
  if (!id) return undefined;
  return curatedById.get(id)?.label ?? advancedLabel(id);
};

export const searchBarcodeOptions = (query: string, group: string | null = "recommended") => {
  const q = query.trim().toLowerCase();
  const ids = group === "recommended" ? CURATED_BARCODE_OPTIONS.map((option) => option.id) : BARCODE_SYMBOL_IDS;
  return ids
    .filter((id) => group === null || barcodeGroups(id).includes(group))
    .filter((id) => !q || id.includes(q) || (curatedById.get(id)?.label.toLowerCase() ?? "").includes(q))
    .map((id): BarcodeOption => {
      const known = curatedById.get(id);
      return {
        ...(known ?? { id, label: advancedLabel(id), description: `Advanced BWIP symbol: ${id}`, icon: "ti ti-barcode" }),
        groups: barcodeGroups(id),
      };
    })
    .slice(0, 60);
};
