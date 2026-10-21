// node --test tests/js/*.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../../app/static/markdown.js");

test("escapes HTML everywhere", () => {
  const out = M.render('<script>alert(1)</script> **<b>x</b>** `<i>`');
  assert.ok(!out.includes("<script>") && !out.includes("<b>") && !out.includes("<i>"));
  assert.ok(out.includes("&lt;script&gt;") && out.includes("<strong>&lt;b&gt;x&lt;/b&gt;</strong>"));
  assert.ok(out.includes("<code>&lt;i&gt;</code>"));
});

test("links: http(s)/mailto only, opened safely", () => {
  assert.equal(M.inline("[docs](https://example.com/a?b=1&c=2)"),
    '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a>');
  assert.ok(!M.render("[x](javascript:alert(1))").includes("href"));
  assert.ok(!M.render('[x](" onmouseover="y)').includes("onmouseover=\""));
  assert.ok(M.inline("<https://a.b/c>").includes('href="https://a.b/c"'));
});

test("inline emphasis, code keeps literal text", () => {
  assert.equal(M.inline("**b** *i* _j_ ~~s~~"), "<strong>b</strong> <em>i</em> <em>j</em> <del>s</del>");
  assert.equal(M.inline("`a *b* \\c`"), "<code>a *b* \\c</code>");
  assert.equal(M.inline("snake_case_name and 2*3*4"), "snake_case_name and 2*3*4");
});

test("blocks: headings, lists, quotes, rules, paragraphs with line breaks", () => {
  const out = M.render("# Title\n\nline one\nline two\n\n- a\n- b\n  - c\n1. x\n2. y\n\n> quoted\n\n---");
  assert.ok(out.startsWith("<h3>Title</h3><p>line one<br>line two</p>"));
  assert.ok(out.includes("<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>"));
  assert.ok(out.includes("<ol><li>x</li><li>y</li></ol>"));
  assert.ok(out.includes("<blockquote><p>quoted</p></blockquote>") && out.endsWith("<hr>"));
});

test("fenced code: language, escaping, still-streaming fence", () => {
  const done = M.render("Here:\n```latex\n\\section{A} & <b>\n```\nafter");
  assert.ok(done.includes('<pre class="md-code" data-lang="latex"><code>\\section{A} &amp; &lt;b&gt;</code></pre>'));
  assert.ok(done.endsWith("<p>after</p>"));
  const open = M.render("```python\nprint(1)");
  assert.ok(open.includes('class="md-code open"') && open.includes("print(1)"));
  assert.deepEqual(M.codeBlocks("a\n```latex\nX\nY\n```\nb\n```\nZ\n```"), [{ lang: "latex", code: "X\nY" }, { lang: "", code: "Z" }]);
});

test("tables with alignment", () => {
  const out = M.render("| Name | Score |\n|:---|---:|\n| a | **1** |\n| b |");
  assert.ok(out.startsWith('<table><thead><tr><th>Name</th><th style="text-align:right">Score</th>'));
  assert.ok(out.includes('<td style="text-align:right"><strong>1</strong></td>'));
  assert.ok(out.includes('<tr><td>b</td><td style="text-align:right"></td></tr>'), "missing cells are empty");
});
