"""The BibTeX engine: parsing with spans, in-place edits, keys, checks,
cleanup, duplicates, citations — and the online parsers on recorded replies."""

from pathlib import Path

import pytest

from app import bibfetch, bibtex as b

FIX = Path(__file__).parent / "fixtures" / "bib"

SRC = r"""% refs for the paper — mail me@example.org
@string{nat = "Nature"}
@preamble{"\newcommand{\noopsort}[1]{}"}

@Article{lecun2015,
  author = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey},
  title = {Deep learning},
  journal = nat,
  year = 2015, month = may,
  pages = "436-444",
  doi = {https://doi.org/10.1038/nature14539},
}

@misc{vaswani2017attention,
      title={Attention Is All You Need},
      author={Ashish Vaswani and Noam Shazeer and others},
      year={2017},
      eprint={1706.03762},
      archivePrefix={arXiv},
      primaryClass={cs.CL}
}
@inproceedings{devlin, title = {{BERT}: Pre-training of Deep Bidirectional Transformers}, author={Devlin, Jacob and Chang, Ming-Wei}, booktitle = "NAACL", year = {2019}}
@article{broken, title = {oops, year = 2020}
@book{knuth, author = {Donald E. Knuth and {\"O}zt{\"u}rk, Ali and van der Berg, Jan}, title={The {\TeX}book}, publisher = {Addison-Wesley}, year = 1984}
"""


def test_parse_entries_strings_and_errors():
    db = b.parse(SRC)
    assert [(e.key, e.type, e.line) for e in db.entries] == [
        ("lecun2015", "article", 5), ("vaswani2017attention", "misc", 14), ("devlin", "inproceedings", 22),
        ("knuth", "book", 24)]
    assert db.strings == {"nat": "Nature"} and len(db.preambles) == 1
    assert db.errors and db.errors[0]["line"] == 23            # the broken entry, then parsing resumes
    e = db.find("lecun2015")
    assert e.get("journal") == "#nat#" and e.get("month") == "#may#" and e.get("year") == "2015"
    assert e.get("pages") == "436-444"                        # quoted value, inner text
    assert db.find("devlin").get("title").startswith("{BERT}")
    assert SRC[e.start:e.end].startswith("@Article{lecun2015,") and SRC[e.start:e.end].endswith("}")
    assert b.display(e, db.strings)["venue"] == "Nature"


def test_values_round_trip_and_macros():
    assert b.encode_value("plain") == "{plain}"
    assert b.encode_value("#nat# x", ["nat"]) == "nat # { x}"
    assert b.encode_value("#jan#") == "jan"
    assert b.encode_value("C#notamacro# stays") == "{C#notamacro# stays}"
    with pytest.raises(b.BibError):
        b.encode_value("{unclosed")
    assert b.decode_value('"a" # nat # {b}') == "a#nat#b"


def test_edit_rewrites_only_that_entry():
    db = b.parse(SRC)
    e = db.find("lecun2015")
    vals = e.as_dict()
    vals["pages"] = "436--444"
    vals["volume"] = "521"
    text = b.replace_entry(db, "lecun2015", b.build_entry(db, "article", "lecun2015", vals, old=e))
    before, after = SRC[:e.start], SRC[e.end:]
    assert text.startswith(before) and text.endswith(after)            # the rest is byte-identical
    body = text[e.start:len(text) - len(after)]
    assert "journal = nat," in body and "year = 2015," in body           # unchanged raw values kept
    assert "pages = {436--444}," in body and "volume = {521}," in body
    assert body.index("pages") < body.index("volume")                    # new fields after the old ones
    again = b.parse(text)
    assert again.find("lecun2015").get("volume") == "521" and not again.errors[1:]


def test_append_and_delete():
    db = b.parse(SRC)
    entry = b.build_entry(db, "article", "new2020", {"title": "T", "author": "A, B", "year": "2020", "journal": "J"})
    text = b.append_entry(db, entry)
    assert text.endswith("@article{new2020,\n  author = {A, B},\n  title = {T},\n  journal = {J},\n  year = {2020},\n}\n")
    text = b.delete_entry(b.parse(text), "devlin")
    assert "devlin" not in text and b.parse(text).find("knuth")
    with pytest.raises(b.BibError):
        b.build_entry(db, "article", "bad key", {})
    with pytest.raises(b.BibError):
        b.build_entry(db, "article", "k", {"title": "{oops"})


def test_names_and_latex_text():
    assert b.parse_name("Ludwig van Beethoven") == {"first": "Ludwig", "von": "van", "last": "Beethoven", "jr": ""}
    assert b.parse_name("van der Berg, Jr, Jan") == {"first": "Jan", "von": "van der", "last": "Berg", "jr": "Jr"}
    assert b.last_names(r"Donald E. Knuth and {\"O}zt{\"u}rk, Ali and {IEEE Computer Society}") == \
        ["Knuth", "Öztürk", "IEEE Computer Society"]
    assert b.authors_short("A, B and C, D") == "A and C" and b.authors_short("A, B and others") == "A et al."
    assert b.latex_to_text(r"Schr{\"o}dinger \'Ecole \c{c}a {\ss} \v{C}ech 1--2 The {\TeX}book") == \
        "Schrödinger École ça ß Čech 1–2 The TeXbook"


def test_key_patterns_and_uniqueness():
    db = b.parse(SRC)
    knuth, vas = db.find("knuth"), db.find("vaswani2017attention")
    assert b.make_key(knuth) == "Knuth1984"
    assert b.make_key(knuth, "[authEtAl:lower][shortyear]") == "knuthetal84"
    assert b.make_key(vas, "[auth][year][veryshorttitle]") == "Vaswani2017Attention"
    assert b.make_key(vas, "[auth.etal]-[shorttitle]") == "Vaswani.etal-AttentionAllYou"
    assert b.make_key(db.find("devlin"), "[authEtAl][year]") == "DevlinAndChang2019"
    assert b.unique_key("Knuth1984", ["knuth1984", "Knuth1984a"]) == "Knuth1984b"


def test_integrity_checks():
    db = b.parse(SRC)
    codes = lambda k: [p["code"] for p in b.entry_problems(db.find(k))]
    assert codes("lecun2015") == ["page_range", "doi_format"]
    assert "missing_required" not in codes("vaswani2017attention")          # @misc needs nothing
    bad = b.parse("@article{x, title={Using BERT and GPT-3}, year={20x}, month={3}, url={https://arxiv.org/abs/2101.00001}}")
    got = {p["code"]: p for p in b.entry_problems(bad.entries[0])}
    assert {"missing_required", "year_format", "month_format", "arxiv_fields", "acronyms"} <= set(got)
    assert got["acronyms"]["message"].endswith("BERT, GPT-3")
    dup = b.parse("@a{k, title={x}}\n@b{K, title={y}}")
    assert b.database_problems(dup)[0]["code"] == "duplicate_key"


def test_cleanup_actions():
    e = b.parse("@article{x, title = {Fine-tuning BERT for {NER} in  NLP}, pages={1 - 5}, month={March},"
                " url={https://doi.org/10.1000/xyz123}, journal={arXiv preprint arXiv:2101.00001}, note={ }}").entries[0]
    v = b.cleanup_values(e, b.CLEANUPS)
    assert v["pages"] == "1--5" and v["month"] == "#mar#"
    assert v["doi"] == "10.1000/xyz123" and "url" not in v
    assert v["eprint"] == "2101.00001" and v["archiveprefix"] == "arXiv" and "journal" not in v
    assert v["title"] == "Fine-tuning {BERT} for {NER} in {NLP}" and "note" not in v


def test_duplicates_and_merge():
    db = b.parse("@a{x, title={Attention is all you need}, year=2017}\n"
                 "@b{y, title={Attention Is All You Need.}, year={2017}, doi={10.5555/3295222.3295349}}\n"
                 "@c{z, title={Attention is all you need}, year={2009}}\n"
                 "@d{p, eprint={1706.03762v2}}@d{q, eprint={1706.03762}}")
    assert b.find_duplicates(db) == [{"keys": ["x", "y"], "reason": "same title"},
                                     {"keys": ["p", "q"], "reason": "same arXiv id"}]
    merged, conflicts = b.merge_values(db.find("x").as_dict(), db.find("y").as_dict())
    assert merged["doi"] == "10.5555/3295222.3295349" and conflicts == []


def test_citations_rename_and_resources():
    files = {"main.tex": "See \\cite{lecun2015, knuth} and \\citep[p.~3]{devlin}. % \\cite{hidden}\n"
                         "\\textcite{lecun2015}\\bibliography{refs,sub/other}",
             "refs.bib": "", "sub/other.bib": "", "x.bib": ""}
    cited = b.citations(files)
    assert sorted(cited) == ["devlin", "knuth", "lecun2015"] and len(cited["lecun2015"]) == 2
    assert cited["lecun2015"][1]["line"] == 2
    out, n = b.rename_citations(files["main.tex"], "lecun2015", "LeCun15")
    assert n == 2 and "\\cite{LeCun15, knuth}" in out and "\\textcite{LeCun15}" in out
    assert b.bib_resources(files) == ["refs.bib", "sub/other.bib"]


# -- online parsers on recorded replies ---------------------------------------
def test_identify():
    cases = {"10.1038/nature14539": ("doi", "10.1038/nature14539"),
             "https://doi.org/10.1038/nature14539": ("doi", "10.1038/nature14539"),
             "arXiv:1706.03762v5": ("arxiv", "1706.03762v5"),
             "https://arxiv.org/abs/1706.03762": ("arxiv", "1706.03762"),
             "hep-th/9901001": ("arxiv", "hep-th/9901001"),
             "ISBN 978-0-262-03561-3": ("isbn", "9780262035613"),
             "0262035618": ("isbn", "0262035618")}
    for text, (kind, ident) in cases.items():
        assert bibfetch.identify(text) == {"kind": kind, "id": ident}, text
    assert bibfetch.identify("attention is all you need") is None
    assert bibfetch.identify("9780262035614") is None                        # bad checksum
    assert bibfetch.bib_name("Jan van der Berg") == "van der Berg, Jan"
    assert bibfetch.bib_name("Wei Wang 0001") == "Wang, Wei"


def test_parsers_on_recorded_replies():
    c = bibfetch.parse_arxiv((FIX / "arxiv_id.xml").read_text())[0]
    assert c["type"] == "misc" and c["fields"]["eprint"] == "1706.03762" and c["fields"]["primaryclass"] == "cs.CL"
    assert c["fields"]["author"].startswith("Vaswani, Ashish and Shazeer, Noam") and c["fields"]["month"] == "#jun#"
    c = bibfetch.parse_crossref((FIX / "crossref_doi.json").read_text())[0]
    assert c["type"] == "article" and c["fields"]["journal"] == "Nature" and c["fields"]["pages"] == "436--444"
    assert c["fields"]["author"] == "LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey" and c["doi"] == "10.1038/nature14539"
    hits = bibfetch.parse_crossref((FIX / "crossref_search.json").read_text())
    assert [h["type"] for h in hits] == ["inproceedings", "inproceedings", "article"]
    assert hits[0]["fields"]["title"] == r"Deep learning \& convolutional networks" and "& conv" in hits[0]["title"]
    d = bibfetch.parse_dblp((FIX / "dblp.json").read_text())
    assert d[0]["type"] == "inproceedings" and d[0]["fields"]["booktitle"] == "NIPS" and d[0]["fields"]["title"] == "Attention is All you Need"
    assert d[0]["fields"]["author"].endswith("Wang, Wei") and d[1]["fields"]["eprint"] == "1706.03762"
    s = bibfetch.parse_semanticscholar((FIX / "semanticscholar.json").read_text())
    assert s[0]["type"] == "inproceedings" and s[0]["fields"]["eprint"] == "1706.03762" and "url" not in s[0]["fields"]
    o = bibfetch.parse_openalex((FIX / "openalex.json").read_text())
    assert o[0]["type"] == "misc" and o[0]["fields"]["eprint"] == "1706.03762"
    assert o[1]["fields"]["pages"] == "436--444" and o[1]["fields"]["journal"] == "Nature"
    bk = bibfetch.parse_openlibrary((FIX / "openlibrary.json").read_text(), "9780262035613")[0]
    assert bk["type"] == "book" and bk["fields"]["publisher"] == "MIT Press" and bk["year"] == "2017"
    db_ = bibfetch.parse_bibtex_candidates((FIX / "doi.bib").read_text(), "doi.org")[0]
    assert db_["fields"]["journal"] == "Nature" and db_["doi"] == "10.1038/nature14539"
