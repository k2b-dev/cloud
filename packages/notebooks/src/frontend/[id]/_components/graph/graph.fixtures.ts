import type { NoteGraph } from "../../../../service/links";
import { seededRandom } from "./layout-net";

export const FIXTURE_NOW = "2026-10-16T17:30:00.000Z";
const NOW = Date.parse(FIXTURE_NOW);
const HOUR = 3_600_000;

// Synthetic source data from the graph prototype; dates deliberately stay frozen.
const MAIN_TREE = `
start|Startseite|5
wein|Wareneingang|2
 anl|Anlieferung anmelden|30
 ann|Annahme prüfen|3
 kuehl|Kühlkette|52
 lpl|Lagerplätze|120
  hoch|Hochregal Gang A–F|400
 ret|Retouren annehmen|75
 schad|Schadensmeldung|26
komm|Kommissionierung|20
 pbs|Pick-by-Scan|8
 kfehl|Kommissionierfehler|44
 nach|Nachschub steuern|170
 lps|Lagerplatzschema|900
 sperr|Sperrbestand|60
 ideen|Ideen Ladezone|1300
vers|Versand|10
 pack|Packrichtlinien|96
 paket|Paketdienste|210
 sped|Speditionsaufträge|33
 gg|Gefahrgut-Versand|150
  un|UN-Nummern|2000
 zoll|Zollpapiere|600
 vschl|Versandschluss 16 Uhr|14
inv|Inventur 2026|1
 zl|Zählliste|0.4
 zt|Zählteams|6
 stich|Stichtagsinventur|28
 diff|Differenzen klären|48
 rb25|Inventur-Rückblick 2025|3000
sich|Sicherheit|400
 stap|Staplerschein|720
 brand|Brandschutz|1500
 eh|Erste Hilfe|2400
 gsl|Gefahrstofflager|800
 psa|Persönliche Schutzausrüstung|1100
 unt|Jährliche Unterweisung|260
onb|Onboarding|90
 tag1|Erster Tag|130
 schicht|Schichtplan|4
 scan|Handscanner einrichten|190
 einp|Einarbeitungsplan|340
 rund|Lagerrundgang|500
 team|Notizen Teamrunde 9. Okt.|170
glos|Glossar|22
ansp|Ansprechpartner|240
aend|Änderungsprotokoll|1.5
park|Parkplatzregelung|2600
rampe|Alte Rampenzeiten|4300`;
const MAIN_LINKS = `
start>wein,komm,vers,inv,sich,onb,glos,ansp,aend,schicht
wein>anl,ann,kuehl,lpl,ret,schad,glos
anl>ansp,schicht
ann>scan,schad,kuehl,glos
kuehl>pack,vers
lpl>lps,hoch
hoch>stap
ret>sperr,schad,paket
schad>ansp
komm>pbs,kfehl,nach,lps,sperr,glos
pbs>scan,kfehl
kfehl>diff
nach>lpl,hoch
lps>glos
sperr>diff
vers>pack,paket,sped,gg,zoll,vschl
pack>gg
gg>un,gsl,unt
sped>ansp,zoll
vschl>schicht
inv>zl,zt,stich,diff,rb25
zt>schicht
stich>zl,scan
diff>sperr,ansp
rb25>diff
sich>stap,brand,eh,gsl,psa,unt
stap>unt
gsl>un,brand
eh>ansp
onb>tag1,schicht,scan,einp,rund
tag1>rund,psa,stap,ansp
einp>wein,komm,vers,unt
rund>lps,brand
scan>glos
aend>kuehl,vschl`;
const EMPTY_TREE = `
hall|Projekt Hallenumbau|3
 zeit|Zeitplan|5
 kost|Kosten|30
 bsa|Brandschutzauflagen|50
 ab|Ansprechpartner Bau|80
 prot|Protokoll Baubesprechung 1|8`;

type Row = { id: string; title: string; parent: string | null; upd: number };
type Link = [string, string];
function parseTree(text: string): Row[] {
  const rows: Row[] = [],
    stack: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const depth = line.length - line.trimStart().length;
    const [id, title, hours] = line.trim().split("|");
    if (!id || !title || !hours) throw new Error("Invalid fixture tree row");
    stack.length = depth;
    rows.push({ id, title, parent: depth ? (stack[depth - 1] ?? null) : null, upd: NOW - Number(hours) * HOUR });
    stack[depth] = id;
  }
  return rows;
}
function parseLinks(text: string): Link[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [source, targets] = line.split(">");
      if (!source || !targets) throw new Error("Invalid fixture links");
      return targets.split(",").map((target): Link => [source, target]);
    });
}
export const HANDBOOK_IDS: Record<string, string> = Object.fromEntries(
  parseTree(MAIN_TREE).map((row) => [row.id, row.id.slice(0, 6).padEnd(6, "0")]),
);

function toGraph(rows: readonly Row[], links: readonly Link[], ids: Readonly<Record<string, string>>): NoteGraph {
  const publicId = (id: string) => {
    const value = ids[id];
    if (!value) throw new Error(`Unknown fixture id: ${id}`);
    return value;
  };
  const seen = new Set<string>();
  const edges = links
    .filter(([source, target]) => {
      const key = `${source}>${target}`;
      if (source === target || seen.has(key) || !ids[source] || !ids[target]) return false;
      seen.add(key);
      return true;
    })
    .map(([source, target]) => ({ source: publicId(source), target: publicId(target) }));
  const inDegree = new Map<string, number>();
  for (const edge of edges) inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  const positions = new Map<string | null, number>();
  return {
    nodes: rows.map((row) => {
      const position = positions.get(row.parent) ?? 0;
      positions.set(row.parent, position + 1);
      const id = publicId(row.id);
      return {
        id,
        title: row.title,
        parentId: row.parent === null ? null : publicId(row.parent),
        position,
        updatedAt: new Date(row.upd).toISOString(),
        inDegree: inDegree.get(id) ?? 0,
      };
    }),
    edges,
  };
}
export function handbookGraph(): NoteGraph {
  return toGraph(parseTree(MAIN_TREE), parseLinks(MAIN_LINKS), HANDBOOK_IDS);
}
export function unlinkedGraph(): NoteGraph {
  const rows = parseTree(EMPTY_TREE);
  return toGraph(rows, [], Object.fromEntries(rows.map((row) => [row.id, row.id.padEnd(6, "0")])));
}

/** Two areas and one link across them: hiding the first area leaves the second note without visible links. */
export function crossAreaGraph(): NoteGraph {
  const rows = parseTree(`
lager|Lager|5
 regal|Regalplan|5
hof|Hof|5
 tor|Torbelegung|5`);
  return toGraph(rows, [["regal", "tor"]], Object.fromEntries(rows.map((row) => [row.id, row.id.padEnd(6, "0")])));
}

export function bigGraph(): NoteGraph {
  const random = seededRandom(7);
  const sections: [string, string[]][] = [
    ["Wareneingang", ["Rampenplanung", "Lieferavis", "Qualitätsprüfung", "Etikettierung", "Retourenannahme"]],
    ["Lager", ["Hochregal", "Blocklager", "Kühlbereich", "Gefahrstoffe", "Lagerplatzvergabe"]],
    ["Kommissionierung", ["Pick-by-Scan", "Pick-by-Voice", "Nachschub", "Chargenführung", "Fehlerquote"]],
    ["Versand", ["Paketdienste", "Spedition", "Zoll", "Verpackung", "Tourenplanung"]],
    ["Fuhrpark", ["Stapler", "Wartung", "Ladestationen", "Fahrzeugpflege", "Schadenfälle"]],
    ["Arbeitssicherheit", ["Brandschutz", "Erste Hilfe", "Unterweisungen", "Schutzausrüstung", "Gefährdungsbeurteilung"]],
    ["Personal", ["Schichtplanung", "Einarbeitung", "Urlaubsplanung", "Schulungen", "Zeiterfassung"]],
  ];
  const questions = ["Ablauf", "Checkliste", "Häufige Fragen", "Störungen", "Vorlage", "Kennzahlen", "Protokoll KW"];
  const rows: Row[] = [],
    links: Link[] = [];
  const age = () => Math.round(random() ** 2.2 * 6000 * 10) / 10 + 0.2;
  const tops = [
    "Übersicht",
    "Glossar",
    "Ansprechpartner",
    "Notfallnummern",
    "Änderungsprotokoll",
    "Standortplan",
    "Leitbild",
    "Projektliste 2026",
    "Lieferantenliste",
    "Ideensammlung",
    "Besprechung 02.10.",
    "Besprechung 09.10.",
    "Altablage",
  ];
  rows.push({ id: "t0", title: "Übersicht", parent: null, upd: NOW - 3 * HOUR });
  const children: { id: string; si: number; orphan: boolean }[] = [];
  sections.forEach(([name, topics], si) => {
    const rid = `r${si}`;
    rows.push({ id: rid, title: name, parent: null, upd: NOW - age() * HOUR });
    links.push(["t0", rid]);
    topics.forEach((topic, ti) => {
      const gid = `g${si}_${ti}`;
      rows.push({ id: gid, title: topic, parent: rid, upd: NOW - age() * HOUR });
      links.push([rid, gid]);
      questions.forEach((question, qi) => {
        const id = `c${si}_${ti}_${qi}`;
        const title = question === "Protokoll KW" ? `${topic}: Protokoll KW ${30 + Math.floor(random() * 12)}` : `${topic}: ${question}`;
        const orphan = random() < 0.08;
        rows.push({ id, title, parent: gid, upd: NOW - age() * HOUR });
        children.push({ id, si, orphan });
        if (!orphan && random() < 0.75) links.push([gid, id]);
      });
    });
  });
  tops.slice(1).forEach((title, i) => rows.push({ id: `t${i + 1}`, title, parent: null, upd: NOW - age() * HOUR }));
  for (const id of ["t1", "t2", "t3", "t4"]) links.push(["t0", id]);
  const live = children.filter((child) => !child.orphan);
  const inDegree = new Map<string, number>();
  const pick = (pool: typeof live) => {
    let total = 0;
    for (const child of pool) total += (inDegree.get(child.id) ?? 0) + 1;
    let remaining = random() * total;
    for (const child of pool) {
      remaining -= (inDegree.get(child.id) ?? 0) + 1;
      if (remaining <= 0) return child;
    }
    const last = pool.at(-1);
    if (!last) throw new Error("Empty fixture target pool");
    return last;
  };
  for (const child of live) {
    const count = Math.floor(random() * 3);
    for (let k = 0; k < count; k++) {
      const pool =
        random() < 0.72
          ? live.filter((other) => other.si === child.si && other.id !== child.id)
          : live.filter((other) => other.si !== child.si);
      const target = pick(pool);
      links.push([child.id, target.id]);
      inDegree.set(target.id, (inDegree.get(target.id) ?? 0) + 1);
    }
    if (random() < 0.22) links.push([child.id, "t1"]);
    if (random() < 0.06) links.push([child.id, "t2"]);
  }
  links.push(["t10", "r0"], ["t11", "r2"], ["t11", "t10"], ["t7", "r4"], ["t5", "r1"], ["t8", "r3"]);
  return toGraph(rows, links, Object.fromEntries(rows.map((row, index) => [row.id, index.toString(36).padStart(6, "0")])));
}

/**
 * The worst realistic notebook for the graph and its list: 1,000 notes in nine areas (more areas than colours), titles
 * at the 200-character limit, an address without a break, one letter, no title, emoji, Japanese, Arabic and
 * Vietnamese, a page that 400 notes link to, and notes without a link.
 */
export function worstGraph(): NoteGraph {
  const random = seededRandom(11);
  const long =
    "Verfahrensanweisung zur Annahme, Prüfung und Einlagerung temperaturgeführter Gefahrstoffe im Außenlager Halle 7 einschließlich Dokumentation der Chargenrückverfolgung und Freigabe durch die Qualitätssicherung";
  const areas = [
    "Qualitätsmanagement und Dokumentation nach DIN EN ISO 9001:2015 für alle Standorte",
    "https://wiki.northwind-industries-holdings.example.com/logistik/wareneingang",
    "Q",
    "🚚 Versand & Touren ✅",
    "倉庫管理の手順と安全規則",
    "دليل المستودع",
    "Quy trình nhập kho và kiểm tra chất lượng",
    "",
    "Archiv",
  ];
  const special = [
    long.slice(0, 200),
    "https://wiki.northwind-industries-holdings.example.com/logistik/wareneingang/annahme-pruefen",
    "Q",
    "",
    "🚚🚚🚚 Touren KW 47 ✅",
    "倉庫内のフォークリフト安全講習",
    "تعليمات السلامة للرافعات الشوكية",
    "Hướng dẫn sử dụng máy quét mã vạch",
    "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
  ];
  const rows: Row[] = [{ id: "hub", title: "Übersicht", parent: null, upd: NOW - 2 * HOUR }];
  const links: Link[] = [];
  const all: string[] = [];
  areas.forEach((area, ai) => {
    const rid = `a${ai}`;
    rows.push({ id: rid, title: area, parent: null, upd: NOW - (ai + 1) * 30 * HOUR });
    links.push(["hub", rid]);
    for (let ni = 0; ni < 110; ni++) {
      const id = `n${ai}_${ni}`;
      const title = ni < special.length ? special[(ni + ai) % special.length]! : `${area.slice(0, 24) || "Notiz"} ${ni + 1}`;
      rows.push({ id, title, parent: rid, upd: NOW - Math.round(random() * 9000) * HOUR });
      all.push(id);
    }
  });
  // up to 1,000 notes: the rest of the slots stay unlinked at the top level
  while (rows.length < 1000) rows.push({ id: `u${rows.length}`, title: `Lose Notiz ${rows.length}`, parent: null, upd: NOW - 400 * HOUR });
  for (const [index, id] of all.entries()) {
    // 400 notes link to the overview, most notes link to one or two others, every 13th to none
    if (index % 13 === 0) continue;
    if (index < 400) links.push([id, "hub"]);
    links.push([id, all[Math.floor(random() * all.length)]!]);
    if (random() < 0.3) links.push([id, all[Math.floor(random() * all.length)]!]);
  }
  return toGraph(rows, links, Object.fromEntries(rows.map((row, index) => [row.id, `w${index.toString(36).padStart(5, "0")}`])));
}

/** The smallest graph with a figure: two notes, one link, and one note without a link (every count at 1). */
export function oneLinkGraph(): NoteGraph {
  const rows = parseTree(`
start|Start|2
 regal|Regalplan|5
 tor|Torbelegung|9`);
  return toGraph(rows, [["regal", "tor"]], Object.fromEntries(rows.map((row) => [row.id, row.id.padEnd(6, "0")])));
}
