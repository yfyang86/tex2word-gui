"""Quick (incremental) vs full live preview.

The contract: whatever ``mode="quick"`` returns — reusing cached blocks or
falling back to a full parse — must equal a fresh full render of the same
files, and the client must be able to rebuild the document from ``segments``
(``None`` = "you already have it").
"""

import random

import pytest
from fastapi.testclient import TestClient

from app.livepreview import PreviewEngine
from app.main import app

from .test_sourcemap import normalize
from .texfixtures import project


class Client:
    """Mimics the browser: keeps the segments it holds and the rev it applied."""

    def __init__(self, engine, files, main="main.tex"):
        self.engine, self.main = engine, main
        self.have, self.rev = {}, None
        self.last = self.render(files, "full")

    def render(self, files, mode):
        got = self.engine.render(("c",), files, self.main, mode=mode, base_rev=self.rev)
        html = "".join(h if h is not None else self.have[k] for k, h in got["segments"])
        self.have = {k: (h if h is not None else self.have[k]) for k, h in got["segments"]}
        self.rev = got["rev"]
        got["rebuilt"] = html
        self.last = got
        return got


def full(files, main="main.tex"):
    return PreviewEngine().render(("ref",), files, main)


def assert_same(got, files):
    ref = full(files)
    assert normalize(got["rebuilt"]) == normalize(ref["html"])
    assert got["outline"] == ref["outline"]
    assert got["statistics"] == ref["statistics"]


def edit(files, path, old, new):
    assert old in files[path], old
    out = dict(files)
    out[path] = files[path].replace(old, new, 1)
    return out


# -- quick path ------------------------------------------------------------------
def test_unchanged_files_reuse_everything():
    files = project()
    c = Client(PreviewEngine(), files)
    got = c.render(files, "quick")
    assert got["mode"] == "quick" and got["chunks"]["reparsed"] == 0
    assert all(h is None for _, h in got["segments"])  # nothing to resend
    assert got["html"] is None
    assert_same(got, files)


def test_editing_a_paragraph_reparses_one_chunk_and_resends_one_segment():
    files = project()
    c = Client(PreviewEngine(), files)
    files = edit(files, "sections/results.tex", "Final words", "Closing words")
    got = c.render(files, "quick")
    assert got["mode"] == "quick", got["reason"]
    assert got["chunks"]["reparsed"] == 1
    sent = [h for _, h in got["segments"] if h is not None]
    assert len(sent) == 1 and "Closing words" in sent[0]
    assert_same(got, files)


def test_numbering_and_refs_stay_global_after_a_quick_insert():
    files = project()
    c = Client(PreviewEngine(), files)
    # a new numbered equation before eq:main shifts its number from 1 to 2
    files = edit(files, "main.tex", "Continued text after a comment.",
                 "Continued text after a comment.\n\n\\begin{equation}\\label{eq:new} z = 1 \\end{equation}\n")
    got = c.render(files, "quick")
    assert got["mode"] == "quick", got["reason"]
    assert 'href="#eq_main">2</a>' in got["rebuilt"]
    assert_same(got, files)


def test_body_macro_definitions_are_seen_by_reparsed_chunks():
    files = project()
    c = Client(PreviewEngine(), files)
    # \vect is defined in the body of method.tex; edit a chunk that uses it
    files = edit(files, "sections/method.tex", "be an input", "be any input")
    got = c.render(files, "quick")
    assert got["mode"] == "quick", got["reason"]
    assert "\\vect" not in got["rebuilt"]
    assert_same(got, files)


def test_appendix_state_carries_into_reparsed_chunks():
    files = project()
    c = Client(PreviewEngine(), files)
    files = edit(files, "main.tex", "Appendix text", "Appendix prose")
    got = c.render(files, "quick")
    assert got["mode"] == "quick", got["reason"]
    assert_same(got, files)


def test_line_shift_updates_anchors_without_reparsing():
    files = project()
    c = Client(PreviewEngine(), files)
    before = c.last["html"]
    files = edit(files, "sections/results.tex", "\\section{Results}", "\n\n\n\\section{Results}")
    got = c.render(files, "quick")
    assert got["mode"] == "quick"
    import re
    lines = lambda html: [int(m) for m in re.findall(r'data-src="3:(\d+)"', html)]
    assert lines(got["rebuilt"]) and lines(got["rebuilt"]) != lines(before)
    assert_same(got, files)


@pytest.mark.parametrize("path,old,new,reason", [
    ("main.tex", "\\title{Synthetic Paper}", "\\title{Renamed}", "preamble"),
    ("sections/method.tex", "be an input", "be an input \\newcommand{\\foo}{x}", "newcommand"),
    ("main.tex", "Transformers are everywhere", "Transformers \\citep{bert2} are", "citation"),
    ("main.tex", "We study things.", "We study other things.", "abstract"),
    ("main.tex", "Continued text", "\\renewcommand{\\R}{X} Continued text", "renewcommand"),
    ("sections/results.tex", "Final words", "\\setcounter{equation}{5}Final words", "setcounter"),
    ("main.tex", "Appendix text", "\\iffalse x \\fi Appendix text", "iffalse"),
])
def test_unsafe_edits_fall_back_to_full_with_a_reason(path, old, new, reason):
    files = project()
    c = Client(PreviewEngine(), files)
    files = edit(files, path, old, new)
    got = c.render(files, "quick")
    assert got["mode"] == "full"
    assert reason in got["reason"] or got["reason"], got["reason"]
    assert_same(got, files)


def test_citation_order_change_falls_back():
    files = project()
    c = Client(PreviewEngine(), files)
    # cite devlin2019 before vaswani2017 → the numeric order changes
    files = edit(files, "main.tex", "See Section~", "As \\citet{devlin2019} show. See Section~")
    files = edit(files, "main.tex", "Transformers are everywhere \\citep{vaswani2017,\n  devlin2019}.",
                 "Transformers are everywhere.")
    got = c.render(files, "quick")
    assert got["mode"] == "full" and "citation" in got["reason"]
    assert_same(got, files)


def test_caption_label_that_leaks_to_an_earlier_block_forces_full():
    # tex2word gives \caption{\label{x}} to the most recent labelable block —
    # here the heading in the previous chunk — so these chunks are entangled.
    main = (
        "\\documentclass{article}\n\\begin{document}\n\\section{Head}\\label{sec:h}\n"
        "Text one.\n\n\\begin{table}\n\\begin{tabular}{l}a\\\\\\end{tabular}\n"
        "\\caption{\\label{tab:x} Cap.}\n\\end{table}\n\nSee \\ref{tab:x}.\n\nTail.\n\\end{document}\n"
    )
    files = {"main.tex": main}
    c = Client(PreviewEngine(), files)
    for old, new in [("Text one.", "Text two."), ("Cap.", "Caption.")]:
        files = edit(files, "main.tex", old, new)
        got = c.render(files, "quick")
        assert got["mode"] == "full", got["reason"]
        assert_same(got, files)
    files = edit(files, "main.tex", "Tail.", "Tail end.")  # outside the span: quick is fine
    got = c.render(files, "quick")
    assert got["mode"] == "quick", got["reason"]
    assert_same(got, files)


EDITS = ["word", "newpara", "equation", "delete", "heading", "refadd", "dup", "list"]


def _random_edit(files, rng):
    files = dict(files)
    cands = [(p, i) for p, c in files.items() if p.endswith(".tex")
             for i, l in enumerate(c.split("\n"))
             if len(l.strip()) > 12 and l.strip()[0].isalpha()]
    p, i = rng.choice(cands)
    lines = files[p].split("\n")
    kind = rng.choice(EDITS)
    if kind == "word":
        lines[i] = lines[i].replace(" ", " edited ", 1)
    elif kind == "newpara":
        lines.insert(i + 1, "\nA new paragraph.\n")
    elif kind == "equation":
        lines.insert(i + 1, "\\begin{equation}\\label{eq:r%d} a=b \\end{equation}" % rng.randrange(99))
    elif kind == "delete":
        del lines[i]
    elif kind == "heading":
        lines.insert(i, "\n\\subsection{Inserted}\\label{sec:ins%d}\n" % rng.randrange(99))
    elif kind == "refadd":
        lines[i] += " See \\ref{sec:ins1} and \\eqref{eq:r1}."
    elif kind == "dup":
        lines.insert(i, lines[i])
    elif kind == "list":
        lines.insert(i + 1, "\n\\begin{enumerate}\n\\item one\n\\item two\n\\end{enumerate}\n")
    files[p] = "\n".join(lines)
    return files


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_random_edit_sequences_match_full_renders(seed):
    rng = random.Random(seed)
    files = project()
    c = Client(PreviewEngine(), files)
    modes = []
    for _ in range(15):
        files = _random_edit(files, rng)
        got = c.render(files, "quick")
        modes.append(got["mode"])
        assert_same(got, files)
    assert "quick" in modes  # the incremental path is actually exercised


def test_full_mode_with_base_rev_still_omits_known_segments():
    files = project()
    c = Client(PreviewEngine(), files)
    got = c.render(files, "full")
    assert got["mode"] == "full"
    assert all(h is None for _, h in got["segments"])
    assert_same(got, files)


def test_stale_base_rev_gets_every_segment():
    eng = PreviewEngine()
    files = project()
    first = eng.render(("c",), files, "main.tex")
    eng.render(("c",), files, "main.tex")  # another tab moves the rev on
    got = eng.render(("c",), files, "main.tex", mode="quick", base_rev=first["rev"])
    assert all(h is not None for _, h in got["segments"]) and got["html"]


def test_sessions_are_bounded():
    eng = PreviewEngine(max_sessions=2)
    files = {"main.tex": "\\documentclass{article}\\begin{document}x\\end{document}"}
    for k in range(4):
        eng.render((k,), files, "main.tex")
    assert len(eng._sessions) == 2


# -- API ---------------------------------------------------------------------------
@pytest.fixture
def client():
    return TestClient(app)


def test_preview_api_quick_round_trip(client):
    files = project()
    pid = client.post("/api/projects", json={"name": "Live", "files": files}).json()["id"]
    try:
        url = f"/api/projects/{pid}/preview"
        first = client.post(url, json={}).json()
        assert first["mode"] == "full" and first["html"] and first["rev"]
        assert first["timings"]["total_ms"] > 0
        client.put(f"/api/projects/{pid}/files/sections/results.tex",
                   json={"content": files["sections/results.tex"].replace("Final words", "Last words")})
        quick = client.post(url, json={"mode": "quick", "base_rev": first["rev"]}).json()
        assert quick["mode"] == "quick" and quick["html"] is None
        changed = [h for _, h in quick["segments"] if h]
        assert len(changed) == 1 and "Last words" in changed[0]
        assert quick["rev"] == first["rev"] + 1
        # an unknown mode is rejected by validation
        assert client.post(url, json={"mode": "turbo"}).status_code == 422
    finally:
        client.delete(f"/api/projects/{pid}")
