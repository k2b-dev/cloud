import { describe, expect, it } from "bun:test";
import { highlight } from "./highlight";

// Captured from 0.32.0 before changing the preset rules.
const fixtures = [
  {
    "preset": "code",
    "input": "export async function run(x) {\n  /* note /* nested marker */ return x >= 12.5 && true; // end\n}",
    "html": "<span class=\"hl-keyword\">export</span> <span class=\"hl-keyword\">async</span> <span class=\"hl-keyword\">function</span> run(x) {\n  <span class=\"hl-comment\">/* note /* nested marker */</span> <span class=\"hl-keyword\">return</span> x <span class=\"hl-operator\">&gt;=</span> <span class=\"hl-number\">12.5</span> <span class=\"hl-operator\">&amp;&amp;</span> <span class=\"hl-keyword\">true</span>; <span class=\"hl-comment\">// end</span>\n}"
  },
  {
    "preset": "code",
    "input": "const x = \"a\\\"b\\\\c\"; let y = 'it\\'s'; const z = `hello\\nworld`;",
    "html": "<span class=\"hl-keyword\">const</span> x <span class=\"hl-operator\">=</span> <span class=\"hl-string\">&quot;a\\&quot;b\\\\c&quot;</span>; <span class=\"hl-keyword\">let</span> y <span class=\"hl-operator\">=</span> <span class=\"hl-string\">&#39;it\\&#39;s&#39;</span>; <span class=\"hl-keyword\">const</span> z <span class=\"hl-operator\">=</span> <span class=\"hl-string\">`hello\\nworld`</span>;"
  },
  {
    "preset": "code",
    "input": "const re = /ab+c[0-9]/gi; const ratio = 6 / 2; const t = `hi ${name}`;",
    "html": "<span class=\"hl-keyword\">const</span> re <span class=\"hl-operator\">=</span> <span class=\"hl-operator\">/</span>ab<span class=\"hl-operator\">+</span>c[<span class=\"hl-number\">0</span><span class=\"hl-operator\">-</span><span class=\"hl-number\">9</span>]<span class=\"hl-operator\">/</span>gi; <span class=\"hl-keyword\">const</span> ratio <span class=\"hl-operator\">=</span> <span class=\"hl-number\">6</span> <span class=\"hl-operator\">/</span> <span class=\"hl-number\">2</span>; <span class=\"hl-keyword\">const</span> t <span class=\"hl-operator\">=</span> <span class=\"hl-string\">`hi ${name}`</span>;"
  },
  {
    "preset": "shell",
    "input": "if [ \"$USER\" ]; then echo ${HOME} $1 $?; # note\nfi",
    "html": "<span class=\"hl-keyword\">if</span> [ <span class=\"hl-string\">&quot;$USER&quot;</span> ]<span class=\"hl-operator\">;</span> <span class=\"hl-keyword\">then</span> echo <span class=\"hl-variable\">${HOME}</span> <span class=\"hl-variable\">$1</span> <span class=\"hl-variable\">$?</span><span class=\"hl-operator\">;</span> <span class=\"hl-comment\"># note</span>\n<span class=\"hl-keyword\">fi</span>"
  },
  {
    "preset": "shell",
    "input": "echo \"a\\\"b\\\\c\" 'plain' && cat file | grep x;",
    "html": "echo <span class=\"hl-string\">&quot;a\\&quot;b\\\\c&quot;</span> <span class=\"hl-string\">&#39;plain&#39;</span> <span class=\"hl-operator\">&amp;&amp;</span> cat file <span class=\"hl-operator\">|</span> grep x<span class=\"hl-operator\">;</span>"
  },
  {
    "preset": "sql",
    "input": "SELECT count(*), \"users\", `table`, [field] FROM t WHERE x = $1 AND y = :name OR z = @id AND a = ?; -- note\n/* block */",
    "html": "<span class=\"hl-keyword\">SELECT</span> <span class=\"hl-function\">count</span><span class=\"hl-operator\">(</span><span class=\"hl-operator\">*</span><span class=\"hl-operator\">)</span><span class=\"hl-operator\">,</span> <span class=\"hl-identifier\">&quot;users&quot;</span><span class=\"hl-operator\">,</span> <span class=\"hl-identifier\">`table`</span><span class=\"hl-operator\">,</span> <span class=\"hl-identifier\">[field]</span> <span class=\"hl-keyword\">FROM</span> t <span class=\"hl-keyword\">WHERE</span> x <span class=\"hl-operator\">=</span> <span class=\"hl-parameter\">$1</span> <span class=\"hl-keyword\">AND</span> y <span class=\"hl-operator\">=</span> <span class=\"hl-parameter\">:name</span> <span class=\"hl-keyword\">OR</span> z <span class=\"hl-operator\">=</span> <span class=\"hl-parameter\">@id</span> <span class=\"hl-keyword\">AND</span> a <span class=\"hl-operator\">=</span> <span class=\"hl-parameter\">?</span><span class=\"hl-operator\">;</span> <span class=\"hl-comment\">-- note</span>\n<span class=\"hl-comment\">/* block */</span>"
  },
  {
    "preset": "sql",
    "input": "SELECT 'it''s', 'a\\'b', \"a\\\"b\", `x` FROM t WHERE n >= 1.25;",
    "html": "<span class=\"hl-keyword\">SELECT</span> <span class=\"hl-string\">&#39;it&#39;&#39;s&#39;</span><span class=\"hl-operator\">,</span> <span class=\"hl-string\">&#39;a\\&#39;b&#39;</span><span class=\"hl-operator\">,</span> <span class=\"hl-identifier\">&quot;a\\&quot;b&quot;</span><span class=\"hl-operator\">,</span> <span class=\"hl-identifier\">`x`</span> <span class=\"hl-keyword\">FROM</span> t <span class=\"hl-keyword\">WHERE</span> n <span class=\"hl-operator\">&gt;=</span> <span class=\"hl-number\">1.25</span><span class=\"hl-operator\">;</span>"
  },
  {
    "preset": "sql",
    "input": "SELECT COUNT \n (x), plain, _identifier FROM t WHERE x <> 2 AND y = NULL;",
    "html": "<span class=\"hl-keyword\">SELECT</span> <span class=\"hl-function\">COUNT</span> \n <span class=\"hl-operator\">(</span>x<span class=\"hl-operator\">)</span><span class=\"hl-operator\">,</span> plain<span class=\"hl-operator\">,</span> _identifier <span class=\"hl-keyword\">FROM</span> t <span class=\"hl-keyword\">WHERE</span> x <span class=\"hl-operator\">&lt;&gt;</span> <span class=\"hl-number\">2</span> <span class=\"hl-keyword\">AND</span> y <span class=\"hl-operator\">=</span> <span class=\"hl-keyword\">NULL</span><span class=\"hl-operator\">;</span>"
  },
  {
    "preset": "code",
    "input": "const re = /\"/g;",
    "html": "<span class=\"hl-keyword\">const</span> re <span class=\"hl-operator\">=</span> <span class=\"hl-operator\">/</span>&quot;<span class=\"hl-operator\">/</span>g;"
  },
  {
    "preset": "code",
    "input": "const re = /'/g;",
    "html": "<span class=\"hl-keyword\">const</span> re <span class=\"hl-operator\">=</span> <span class=\"hl-operator\">/</span>&#39;<span class=\"hl-operator\">/</span>g;"
  },
  {
    "preset": "code",
    "input": "const re = /`/g;",
    "html": "<span class=\"hl-keyword\">const</span> re <span class=\"hl-operator\">=</span> <span class=\"hl-operator\">/</span>`<span class=\"hl-operator\">/</span>g;"
  },
  {
    "preset": "code",
    "input": "\"\\\"a\\\"a\\\"a\\",
    "html": "&quot;\\&quot;a\\&quot;a\\&quot;a\\"
  },
  {
    "preset": "code",
    "input": "'\\'a\\'a\\'a\\",
    "html": "&#39;\\&#39;a\\&#39;a\\&#39;a\\"
  },
  {
    "preset": "code",
    "input": "`\\`a\\`a\\`a\\",
    "html": "`\\`a\\`a\\`a\\"
  },
  {
    "preset": "shell",
    "input": "${open\n${ok}",
    "html": "${open\n<span class=\"hl-variable\">${ok}</span>"
  },
  {
    "preset": "shell",
    "input": "${} ${ok}",
    "html": "${} <span class=\"hl-variable\">${ok}</span>"
  },
  {
    "preset": "shell",
    "input": "\"\\\"a\\\"a\\\"a\\",
    "html": "&quot;\\&quot;a\\&quot;a\\&quot;a\\"
  },
  {
    "preset": "sql",
    "input": "[open\n[ok]",
    "html": "[open\n<span class=\"hl-identifier\">[ok]</span>"
  },
  {
    "preset": "sql",
    "input": "[] [ok]",
    "html": "[] <span class=\"hl-identifier\">[ok]</span>"
  },
  {
    "preset": "sql",
    "input": "\"\\\"a\\\"a\\\"a\\",
    "html": "&quot;\\&quot;a\\&quot;a\\&quot;a\\"
  },
  {
    "preset": "sql",
    "input": "'a''a''a\\",
    "html": "<span class=\"hl-string\">&#39;a&#39;&#39;a&#39;</span>&#39;a\\"
  }
] as const;

describe("highlight.presets golden output", () => {
  for (const [index, { preset, input, html }] of fixtures.entries()) {
    it(`${preset} fixture ${index + 1} matches 0.32.0 byte for byte`, () => {
      expect(highlight.presets[preset](input)).toBe(html);
    });
  }
});
