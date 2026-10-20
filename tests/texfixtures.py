"""Synthetic multi-file LaTeX projects shared by the source-map / live-preview tests.

They deliberately mix the constructs the instrumentation must respect: nested
``\\input`` across folders, comments, inline and display math (including math
spanning lines), verbatim, TikZ, tables, floats with captions and labels,
lists, footnotes spanning lines, multi-line citation lists, theorems, a macro
defined in the body, an appendix and a bibliography.
"""

MAIN = r"""\documentclass{article}
\usepackage{amsmath,amsthm,natbib,graphicx,tikz}
\newtheorem{theorem}{Theorem}
\newcommand{\R}{\mathbb{R}}
\title{Synthetic Paper}
\author{A. Author}
\begin{document}
\maketitle

\begin{abstract}
We study things.
They are interesting.
\end{abstract}

\section{Introduction}\label{sec:intro}
Transformers are everywhere \citep{vaswani2017,
  devlin2019}. See Section~\ref{sec:method} and
Eq.~\eqref{eq:main}.% a comment that eats the newline
Continued text after a comment.

% \input{sections/ghost}
\input{sections/method}
\input{sections/results}

\appendix

\section{Extra}\label{sec:extra}
Appendix text with $x^2$.

\bibliographystyle{plainnat}
\bibliography{refs}
\end{document}
"""

METHOD = r"""\section{Method}\label{sec:method}
\newcommand{\vect}[1]{\mathbf{#1}}

Let $\vect{x} \in \R^n$ be an input, with a long inline formula
$a + b +
 c = d$ spanning lines.

\begin{equation}\label{eq:main}
  y = W \vect{x} + b
\end{equation}

\subsection{Details}
\begin{itemize}
  \item First point with a footnote\footnote{A footnote
    spanning two lines.}.
  \item Second point.
\end{itemize}

\begin{theorem}[Bound]\label{thm:bound}
The error is bounded.
\end{theorem}

\begin{verbatim}
code { with $ dollars and } braces
\end{verbatim}

\input{sub/detail}
"""

DETAIL = r"""\paragraph{Deep detail}
A paragraph in a nested folder, referencing Figure~\ref{fig:plot}.

\begin{figure}[t]
  \centering
  \begin{tikzpicture}
    \draw (0,0) -- (1,1);
    text inside tikz
  \end{tikzpicture}
  \caption{A plot of
    things.}\label{fig:plot}
\end{figure}
"""

RESULTS = r"""\section{Results}\label{sec:results}
Our results are in Table~\ref{tab:res}.

\begin{table}[h]
  \centering
  \begin{tabular}{lc}
    Model & Score \\
    Ours & 1.0 \\
  \end{tabular}
  \caption{Results.}\label{tab:res}
\end{table}

Final words of the results.
\[
  E = mc^2
\]
After display math.
"""

BIB = r"""@article{vaswani2017,
  title={Attention is all you need},
  author={Vaswani, Ashish and Shazeer, Noam},
  journal={NeurIPS},
  year={2017}
}
@article{devlin2019,
  title={BERT},
  author={Devlin, Jacob},
  journal={NAACL},
  year={2019}
}
"""


def project() -> dict[str, str]:
    return {
        "main.tex": MAIN,
        "sections/method.tex": METHOD,
        "sections/results.tex": RESULTS,
        "sections/sub/detail.tex": DETAIL,
        "refs.bib": BIB,
    }
