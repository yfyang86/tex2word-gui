import pytest
from fastapi.testclient import TestClient

from app import service
from app.main import app

DOC = r"""\documentclass{article}
\usepackage{amsmath}
\title{Sparse Mixtures}
\author{Lena Ortiz}
\begin{document}
\maketitle
\section{Introduction}
Transformer inference cost grows. The relation is $E=mc^2$.
\begin{equation}
  \int_0^1 x^2 \, dx = \frac{1}{3}.
\end{equation}
\section{Method}
Given tokens $x_1,\dots,x_n$, the router assigns experts.
\begin{itemize}\item one \item two\end{itemize}
\end{document}
"""


@pytest.fixture
def client():
    return TestClient(app)


def test_render_document_html_outline_stats():
    result = service.run_source(DOC, service.ConvertOptions())
    data = service.preview(result)
    # HTML has headings and typeset MathML (latex2mathml installed)
    assert "<h1" in data["html"] or "Introduction" in data["html"]
    assert "<math" in data["html"]  # MathML, not a fallback
    # outline contains the two sections and the numbered equation
    kinds = [o["type"] for o in data["outline"]]
    assert kinds.count("heading") == 2
    assert "equation" in kinds
    headings = [o["text"] for o in data["outline"] if o["type"] == "heading"]
    assert "Introduction" in headings and "Method" in headings
    # statistics
    st = data["statistics"]
    assert st["headings"] == 2 and st["equations"] >= 1 and st["words"] > 0
    assert "report" in data


REFS = r"""\documentclass{article}\usepackage{amsmath,natbib}
\begin{document}
\section{Intro}\label{sec:intro}
Forward ref to Section~\ref{sec:method}; equation~\eqref{eq:a}; cite \citep{vaswani2017}.
\begin{equation}\label{eq:a} y = x^2. \end{equation}
\section{Method}\label{sec:method} Body.
\bibliographystyle{plainnat}\bibliography{refs}
\end{document}
"""


def test_refs_resolve_to_engine_numbers_and_anchors():
    # tex2word owns structure; the preview resolves \ref to computed numbers,
    # links them to the engine's bookmarks, and uses Cite.rendered for citations.
    data = service.preview(service.run_source(REFS, service.ConvertOptions()))
    html = data["html"]
    # forward \ref{sec:method} → "2", linked to tex2word's bookmark (sec_method)
    assert '<a class="ref" href="#sec_method">2</a>' in html
    # \eqref{eq:a} → "1", linked to the equation bookmark
    assert '<a class="ref" href="#eq_a">1</a>' in html
    # the heading carries that same bookmark id
    assert 'id="sec_method"' in html
    # citation came from the engine, not a [keys] stub
    assert '<span class="cite">(vaswani2017)</span>' in html
    assert "[vaswani2017]" not in html


def test_number_by_section_changes_numbering():
    opts = service.ConvertOptions(number_by_section=True)
    data = service.preview(service.run_source(REFS, opts), number_by_section=True)
    # equation in section 1 becomes "1.1"; the ref resolves to it
    assert '<a class="ref" href="#eq_a">1.1</a>' in data["html"]


def test_theorem_with_title_renders():
    # regression: Theorem.title is an inline-node list, not a string —
    # rendering must not crash (previously raised in html.escape).
    doc = (
        r"\documentclass{article}\usepackage{amsmath}"
        r"\newtheorem{theorem}{Theorem}"
        r"\begin{document}"
        r"\begin{theorem}[Compact Skill Representation]"
        r"Let $\mathcal{S}$ be a set. Then $x^2 \geq 0$."
        r"\end{theorem}\end{document}"
    )
    data = service.preview(service.run_source(doc, service.ConvertOptions()))
    assert "Compact Skill Representation" in data["html"]
    assert "<math" in data["html"]


def test_preview_endpoint(client):
    r = client.post("/api/preview", json={"source": DOC})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Sparse Mixtures"
    assert any(o["type"] == "heading" for o in body["outline"])
    assert "<math" in body["html"]


def test_preview_endpoint_rejects_empty(client):
    assert client.post("/api/preview", json={"source": "  "}).status_code == 422


def test_project_preview_endpoint(client):
    pid = client.post(
        "/api/projects",
        json={"name": "Prev", "files": {"main.tex": DOC}},
    ).json()["id"]
    r = client.post(f"/api/projects/{pid}/preview", json={})
    assert r.status_code == 200, r.text
    assert r.json()["statistics"]["headings"] == 2
    client.delete(f"/api/projects/{pid}")


def test_project_preview_unknown_404(client):
    assert client.post("/api/projects/nope/preview", json={}).status_code == 404
