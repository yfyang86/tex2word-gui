"""Source map: flattening with origins, marker instrumentation, sync anchors."""

import os
import re
import tempfile

import pytest
from fastapi.testclient import TestClient
from tex2word.frontend import parse_document
from tex2word.frontend.preprocess import flatten_inputs, strip_comments
from tex2word.transforms import resolve_crossrefs

from app import preview as P
from app import sourcemap as sm
from app.livepreview import PreviewEngine
from app.main import app

from .texfixtures import project


def _materialise(files, d):
    for p, c in files.items():
        os.makedirs(os.path.dirname(os.path.join(d, p)), exist_ok=True)
        with open(os.path.join(d, p), "w", encoding="utf-8") as fh:
            fh.write(c)


def _engine_flatten(files, root):
    with tempfile.TemporaryDirectory() as d:
        _materialise(files, d)
        return flatten_inputs(strip_comments(files[root]), d)


def _plain_render(files, root):
    with tempfile.TemporaryDirectory() as d:
        _materialise(files, d)
        doc, rep = parse_document(files[root], d)
    resolve_crossrefs(doc, rep)
    return P.render_document(doc)


def normalize(html: str) -> str:
    """Drop everything the instrumentation adds (keys, anchors, marker paragraphs)."""
    html = re.sub(r' data-k="[0-9a-f]+"', "", html)
    html = re.sub(r' data-src="[0-9:]+"', "", html)
    html = re.sub(r'<span class="sl"></span>', "", html)
    return re.sub(r'<p class="srcmark">\s*</p>', "", html)


def _anchors(html):
    """[(file_idx, line, following text)] for every sync anchor, in order."""
    out = []
    for m in re.finditer(r'data-src="(\d+):(\d+)"[^>]*>(?:</span>)?([^<]{0,40})', html):
        out.append((int(m.group(1)), int(m.group(2)), m.group(3)))
    return out


# -- flattening ---------------------------------------------------------------
def test_flatten_matches_engine_byte_for_byte():
    files = project()
    fl = sm.flatten(files, "main.tex")
    assert fl.text == _engine_flatten(files, "main.tex")
    # files in first-appearance order; the commented-out ghost is not included
    assert fl.files == ["main.tex", "sections/method.tex", "sections/sub/detail.tex",
                        "sections/results.tex"]


@pytest.mark.parametrize("files,root", [
    ({"a.tex": "x\\input{b}y\\input{missing}z", "b.tex": "B%c\nB2"}, "a.tex"),
    ({"a.tex": "\\import{d/}{e} \\subimport{d/}{e.tex}", "d/e.tex": "E"}, "a.tex"),
    ({"a.tex": "% \\input{b}\n\\input{ b }\n\\include{c}", "b.tex": "B", "c.tex": "C\n"}, "a.tex"),
    ({"a.tex": "\\input{a}", }, "a.tex"),  # self-include: depth-limited like the engine
])
def test_flatten_edge_cases_match_engine(files, root):
    assert sm.flatten(files, root).text == _engine_flatten(files, root)


def test_origin_maps_back_to_file_and_line_through_comments():
    files = {"a.tex": "l1\n% gone\nl3 % tail\nl4\n\\input{b}\nl6", "b.tex": "b1\n\nb3"}
    fl = sm.flatten(files, "a.tex")
    def where(needle):
        fi, line = fl.origin(fl.text.index(needle))
        return fl.files[fi], line
    assert where("l3") == ("a.tex", 3)
    assert where("l4") == ("a.tex", 4)
    assert where("b3") == ("b.tex", 3)
    assert where("l6") == ("a.tex", 6)
    assert fl.includes == [(0, 5, 1)]


# -- instrumentation --------------------------------------------------------------
def _marked_text(files, root="main.tex"):
    inst = sm.build(files, root)
    return inst, "".join(c.marked(1) for c in inst.chunks)


def _contexts_with_markers(text):
    """The source text right after each marker."""
    return [text[m.end():m.end() + 25] for m in sm.MARKER_RE.finditer(text)]


def test_markers_skip_math_verbatim_tikz_tables_and_groups():
    inst, text = _marked_text(project())
    after = _contexts_with_markers(text)
    # never inside math spanning lines, verbatim, tikz, tabular or a brace group
    assert not any(a.startswith(" c = d") for a in after)
    for env in ("verbatim", "tikzpicture", "tabular"):
        for m in re.finditer(rf"\\begin\{{{env}\}}(.*?)\\end\{{{env}\}}", text, re.S):
            assert "\ue000" not in m.group(1), env
    assert not any(a.lstrip().startswith("devlin") for a in after)          # \citep{a,\n b}
    assert not any(a.lstrip().startswith("spanning two") for a in after)    # \footnote{…\n…}
    # … but present for headings, list items, captions, text lines, display blocks
    assert any(a.startswith("Introduction") for a in after)
    assert any(a.startswith("First point") for a in after)
    assert any(a.startswith("A plot of") for a in after)
    assert any(a.startswith("Transformers are") for a in after)
    assert any(a.startswith("\\begin{equation}") for a in after)
    # math stays marker-free in every chunk
    for m in re.finditer(r"\\begin\{equation\}.*?\\end\{equation\}|\\\[.*?\\\]", text, re.S):
        assert "\ue000" not in m.group(0)
    assert "$a + b +\n c = d$" in text  # the line-spanning inline formula is intact


def test_no_markers_in_the_preamble():
    inst = sm.build(project(), "main.tex")
    assert "\ue000" not in inst.prefix
    assert inst.title_origin == (0, 5)  # \title on main.tex line 5


def test_chunks_split_only_at_top_level_blank_lines():
    inst = sm.build(project(), "main.tex")
    for c in inst.chunks:
        # every chunk is balanced with respect to environments
        begins = len(re.findall(r"\\begin\{", c.text))
        ends = len(re.findall(r"\\end\{", c.text))
        assert begins == ends, c.text[:80]


def test_instrumented_render_equals_plain_render():
    files = project()
    ref = _plain_render(files, "main.tex")
    got = PreviewEngine().render(("t",), files, "main.tex")
    assert normalize(got["html"]) == normalize(ref["html"])
    assert got["outline"] == ref["outline"]
    assert got["statistics"] == ref["statistics"]


@pytest.mark.parametrize("doc", [
    r"\documentclass{article}\begin{document}Hello $x$ world.\end{document}",
    "\\documentclass{article}\n\\begin{document}\n\\section{A}\nText\n\n\\begin{enumerate}\n"
    "\\item[(a)] one\n\\item two\n\\end{enumerate}\n$$ x\n= y $$\nend\n\\end{document}\n",
    "No document environment at all.\n\nSecond paragraph \\textbf{bold}.\n",
    "\\documentclass{article}\n\\begin{document}\n\\begin{quote}\nQuoted\ntext\n\\end{quote}\n"
    "\\begin{description}\n\\item[Term] defined\n\\end{description}\n\\end{document}",
])
def test_instrumentation_is_invisible_on_varied_documents(doc):
    files = {"main.tex": doc}
    ref = _plain_render(files, "main.tex")
    got = PreviewEngine().render(("t",), files, "main.tex")
    assert normalize(got["html"]) == normalize(ref["html"])


def test_anchors_point_at_the_right_file_and_line():
    files = project()
    got = PreviewEngine().render(("t",), files, "main.tex")
    names = got["source_map"]["files"]
    found = {(names[f], line): text for f, line, text in _anchors(got["html"])}
    line_of = lambda path, needle: next(i + 1 for i, l in enumerate(files[path].split("\n")) if needle in l)
    assert ("main.tex", line_of("main.tex", "Transformers are")) in found
    assert ("sections/method.tex", line_of("sections/method.tex", "First point")) in found
    assert ("sections/sub/detail.tex", line_of("sections/sub/detail.tex", "A plot of")) in found
    assert ("sections/results.tex", line_of("sections/results.tex", "Final words")) in found
    # the title is anchored to its \title line
    assert 'data-src="0:5"' in got["html"]
    # include edges let the editor jump from an \input line into the file
    inc = {(names[a], line, names[b]) for a, line, b in got["source_map"]["includes"]}
    assert ("main.tex", line_of("main.tex", "\\input{sections/method}"), "sections/method.tex") in inc


def test_body_anchors_are_in_document_order_per_file():
    got = PreviewEngine().render(("t",), project(), "main.tex")
    body = got["html"].split("</div>", 1)[1]  # after the head (title + abstract)
    per_file = {}
    for f, line, _ in _anchors(body):
        per_file.setdefault(f, []).append(line)
    assert len(per_file) == 4
    for lines in per_file.values():
        assert lines == sorted(lines)


def test_engine_failure_on_markers_falls_back_to_plain(monkeypatch):
    calls = []
    real = PreviewEngine._parse

    def flaky(source, files, csl):
        calls.append("\ue000" in source)
        if "\ue000" in source:
            raise RuntimeError("engine choked on a marker")
        return real(source, files, csl)

    monkeypatch.setattr(PreviewEngine, "_parse", staticmethod(flaky))
    got = PreviewEngine().render(("t",), project(), "main.tex")
    assert calls == [True, False]
    assert got["source_map"] is None and "data-src" not in got["html"]
    assert "Introduction" in got["html"]


# -- render root -------------------------------------------------------------------
def test_root_detection():
    files = project()
    assert sm.is_root_source(files["main.tex"])
    assert not sm.is_root_source(files["sections/method.tex"])
    assert not sm.is_root_source("% \\documentclass{article}\ntext")
    assert sm.including_root(files, "sections/sub/detail.tex") == "main.tex"
    assert sm.including_root(files, "refs.bib") is None


@pytest.fixture
def client():
    return TestClient(app)


def test_preview_of_a_subfile_renders_the_whole_document(client):
    pid = client.post("/api/projects", json={
        "name": "Sub", "main_path": "main.tex", "files": project()}).json()["id"]
    try:
        body = client.post(f"/api/projects/{pid}/preview",
                           json={"main_path": "sections/method.tex"}).json()
        assert body["main_path"] == "main.tex"
        heads = [o["text"] for o in body["outline"] if o["type"] == "heading"]
        assert "Introduction" in heads and "Method" in heads and "Results" in heads
        assert body["source_map"]["files"][0] == "main.tex"
    finally:
        client.delete(f"/api/projects/{pid}")
