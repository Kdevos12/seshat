"""Prints the documents that the real lean-lsp-mcp builds for tactics of lean_multi_attempt.

Run by real-server.test.ts with the Python that has lean-lsp-mcp installed (LEAN_LSP_MCP_PYTHON):
    python -I real_attempt_texts.py cases.json
`cases.json` is a list of {"lines": [...], "line": n, "column": c, "snippet": "..."}: the lines of a file,
the line asked (from 1), the column (from 1, in characters) and the tactic. The output is a JSON object
with the installed version and, for each case, the document of `build_attempt_text`, reading the file
text with splitlines() as `multi_attempt_lsp` does. Nothing else of the server runs: no Lean, no network.
"""
import importlib.metadata
import json
import sys

from lean_lsp_mcp.attempt_utils import build_attempt_text
from lean_lsp_mcp.diagnostic_utils import get_line_context, resolve_multi_attempt_column

with open(sys.argv[1], encoding="utf-8") as handle:
    cases = json.load(handle)

documents = []
for case in cases:
    lines = ("\n".join(case["lines"]) + "\n").splitlines()
    context = get_line_context(lines, case["line"])
    column = resolve_multi_attempt_column(context, case["column"])
    documents.append(build_attempt_text(lines, context, column, case["snippet"], case["line"])[1])

json.dump({"version": importlib.metadata.version("lean-lsp-mcp"), "documents": documents}, sys.stdout, ensure_ascii=False)
