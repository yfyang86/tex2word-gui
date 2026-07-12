"""Markdown → LaTeX math handling.

Regression suite for the reported bug: math written in the delimiter styles LLMs
emit (``$…$``, ``\\(…\\)``, ``$$…$$``, ``\\[…\\]``) was being LaTeX-escaped into
plain text (e.g. ``\\(\\sum x_a\\)`` → ``(\\textbackslash{}sum x\\_a)``). Math is
now extracted before Markdown parsing and restored after, so its LaTeX is never
escaped and every delimiter style is recognised — while code stays literal.
"""

from app import ingest, service


def body(md: str) -> str:
    tex = ingest.markdown_to_latex(md)
    return tex.split("\\begin{document}\n", 1)[1].rsplit("\\end{document}", 1)[0].strip()


# -- inline math -------------------------------------------------------------
def test_dollar_inline_preserved():
    assert body(r"Energy $E=mc^2$ here.") == r"Energy $E=mc^2$ here."


def test_paren_inline_becomes_dollar():
    # \(…\) is the main LLM failure mode — must not be escaped
    out = body(r"Sum \(\sum x_a\) done.")
    assert out == r"Sum $\sum x_a$ done."
    assert "textbackslash" not in out and r"\_" not in out


def test_commands_and_subscripts_not_escaped():
    for src in (r"$\frac{a}{b}$", r"$x_i^2$", r"\(\alpha_j + \beta^k\)"):
        out = body(src)
        assert "textbackslash" not in out
        assert r"\_" not in out and r"\^" not in out and r"\{" not in out


def test_multiple_math_spans_one_paragraph():
    out = body(r"First $a_1$ then \(b_2\) and $c_3$.")
    assert out == r"First $a_1$ then $b_2$ and $c_3$."


# -- display math ------------------------------------------------------------
def test_dollar_block_becomes_equation():
    out = body("Text:\n\n$$\n\\int_0^1 x\\,dx\n$$\n")
    assert "\\begin{equation}" in out and "\\int_0^1 x\\,dx" in out


def test_bracket_display_becomes_equation():
    out = body(r"See \[\sum_{k=1}^n k\] above.")
    assert "\\begin{equation}" in out and "\\sum_{k=1}^n k" in out
    assert "textbackslash" not in out


def test_inline_double_dollar_not_garbled():
    # $$…$$ on the same line as text used to garble to \$$…$\$
    out = body(r"Inline $$\sum x_a$$ display.")
    assert "\\begin{equation}" in out and "\\sum x_a" in out
    assert "\\$" not in out


def test_display_math_in_list_item():
    out = body("- item with \\[y = mx + b\\]\n")
    assert "\\begin{equation}" in out and "y = mx + b" in out


# -- code and money must stay literal ---------------------------------------
def test_math_in_inline_code_is_literal():
    # code content is shown verbatim (escaped for \texttt), never turned into math
    out = body(r"Code `$x$` and `\(y\)` stay literal.")
    assert r"\texttt{\$x\$}" in out
    assert r"\texttt{\textbackslash{}(y\textbackslash{})}" in out


def test_math_in_fenced_code_is_literal():
    out = body("```\n$not math$ and \\(no\\)\n```\n")
    assert "\\begin{verbatim}" in out
    assert "$not math$" in out and "\\(no\\)" in out


def test_bare_dollars_are_escaped_not_math():
    out = body(r"Costs $5 and $10 total.")
    assert out == r"Costs \$5 and \$10 total."


def test_bold_around_math():
    assert body(r"**$\alpha$**") == r"\textbf{$\alpha$}"


# -- end to end through the engine ------------------------------------------
def test_llm_style_math_reaches_the_docx_as_omml():
    md = ("# Method\n\nWe use inline \\(\\sum_i x_i\\) and a display equation:\n\n"
          "\\[\n\\hat{y} = W x + b\n\\]\n")
    files = ingest.from_markdown("Doc", md)
    tex = files["main.tex"]
    assert "$\\sum_i x_i$" in tex and "\\begin{equation}" in tex
    # the converted LaTeX yields real Word math, not raw-text fallback
    _docx, report = service.convert_project(files, "main.tex", service.ConvertOptions())
    assert report["math"]["omml"] >= 2
