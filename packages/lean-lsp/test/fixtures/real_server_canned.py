"""The real lean-lsp-mcp, with the two things that need Lean or the network replaced by canned values.

Used by real-server.test.ts (documentation/lean-lsp.md, "Tests"): `LEAN_LSP_MCP_PYTHON=... pnpm test`.
The tools, their argument checks, the rate limits, the words of their errors and the shapes of their
results are the real server's. Only the lowest layers are replaced:

* the language server (leanclient): a canned client answers `content`, `barrier`, `goal`, `term_goal`
  and `diagnostics`, and a canned scratch pool takes the trial documents of `lean_multi_attempt`,
  which the real `build_attempt_text` built, and appends them to `<project>/.canned-trials.json`;
* the network: `urllib.request.urlopen`, the one call that every search tool ends in. What it does
  is read from `<project>/.canned.json` at each call, so that a test can change it between calls:

      {"loogle": "ok", "leansearch": "http503", "leanfinder": "dns", "hammer": "reset",
       "goal": "goals" | "complete" | "no_goal", "barrier": "timeout", "diagnostics": "partial"}

  A site is "ok" unless it names one of the failures in FAILURES, each raised as urllib raises it.

Run it as `python -I real_server_canned.py` with LEAN_PROJECT_PATH set (the harness sets it).
"""

import http.client
import json
import os
import socket
import types
import urllib.error
import urllib.request

from leanclient.aio import LeanRequestTimeout
from lean_lsp_mcp import attempt_utils, server
from lean_lsp_mcp.tools import diagnostics, goals, search

PROJECT = os.path.realpath(os.environ["LEAN_PROJECT_PATH"])
CONTROL = os.path.join(PROJECT, ".canned.json")
TRIALS = os.path.join(PROJECT, ".canned-trials.json")
GOAL = "n : ℕ\n⊢ n + 0 = n"


def control() -> dict:
    try:
        with open(CONTROL, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return {}


# --- the network ---------------------------------------------------------------------------------

ANSWERS = {
    "loogle": {"hits": [{"name": "Nat.add_comm", "type": "∀ (n m : ℕ), n + m = m + n", "module": "Init.Core"}]},
    "leansearch": [[{"result": {"name": ["Nat", "add_comm"], "module_name": ["Mathlib", "Algebra"], "kind": "theorem", "type": "∀ (n m : ℕ), n + m = m + n"}}]],
    "leanfinder": {"results": [{"formal_name": "Nat.add_comm", "informal_name": "commutativity", "kind": "theorem", "type": "∀ n m, n + m = m + n", "informal_description": "d", "path": "Mathlib/Data/Nat"}]},
    "hammer": [{"name": "Nat.add_comm"}, {"name": "Nat.add_zero"}],
}


def _raise(error: BaseException):
    raise error


# The failures of a network call, as urllib and http.client raise them (the text is Python's own).
FAILURES = {
    "http503": lambda url: urllib.error.HTTPError(url, 503, "Service Unavailable", None, None),
    "dns": lambda url: urllib.error.URLError(socket.gaierror(-2, "Name or service not known")),
    "refused": lambda url: urllib.error.URLError(ConnectionRefusedError(111, "Connection refused")),
    "connect_timeout": lambda url: urllib.error.URLError(TimeoutError("timed out")),
    "timeout": lambda url: TimeoutError("timed out"),
    "reset": lambda url: ConnectionResetError(104, "Connection reset by peer"),
    "closed": lambda url: http.client.RemoteDisconnected("Remote end closed connection without response"),
}


class Response:
    def __init__(self, body: bytes):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self) -> bytes:
        return self.body


def site_of(request) -> str:
    sent = json.loads(request.data) if request.data else {}
    if "/json?q=" in request.full_url:
        return "loogle"
    if "query" in sent:
        return "leansearch"
    if "inputs" in sent:
        return "leanfinder"
    return "hammer"


def canned_urlopen(request, timeout=None, context=None):
    site = site_of(request)
    mode = control().get(site, "ok")
    if mode in FAILURES:
        _raise(FAILURES[mode](request.full_url))
    if mode == "html":
        return Response(b"<html>Bad gateway</html>")
    return Response(json.dumps(ANSWERS[site]).encode("utf-8"))


urllib.request.urlopen = canned_urlopen


# --- the language server -------------------------------------------------------------------------


class Report:
    """What leanclient's `diagnostics` returns."""

    def __init__(self, partial: bool):
        self.partial = partial
        self.fatal_error = False
        self.has_errors = True
        self.processing_ranges = [{"start": {"line": 2, "character": 0}, "end": {"line": 4, "character": 0}}] if partial else []
        # On the contract's sketch (the harness's tests): the theorem is on line 3, its `sorry` on line 5.
        self.items = [
            {"severity": 1, "message": "unsolved goals\nn : ℕ\n⊢ n + 0 = n", "range": {"start": {"line": 4, "character": 2}, "end": {"line": 4, "character": 7}}, "fullRange": {"start": {"line": 2, "character": 0}, "end": {"line": 4, "character": 7}}, "tags": [], "source": "Lean 4"},
            {"severity": 2, "message": "declaration uses 'sorry'", "range": {"start": {"line": 2, "character": 8}, "end": {"line": 2, "character": 22}}, "fullRange": {"start": {"line": 2, "character": 8}, "end": {"line": 2, "character": 22}}, "source": "Lean 4"},
        ]


class Client:
    def content(self, rel: str) -> str:
        with open(os.path.join(PROJECT, rel), encoding="utf-8") as handle:
            return handle.read()

    async def barrier(self, rel: str, timeout=None):
        if control().get("barrier") == "timeout":
            raise LeanRequestTimeout("barrier timed out")

    async def goal(self, rel: str, line: int, column: int, fresh: bool = False):
        mode = control().get("goal", "goals")
        return types.SimpleNamespace(status="goals" if mode == "goals" else mode, goals=[GOAL] if mode == "goals" else [])

    async def term_goal(self, rel: str, line: int, column: int):
        return {"goal": "```lean\nℕ\n```"}

    async def diagnostics(self, rel: str, fresh: bool = True, timeout=None, partial_ok: bool = False):
        return Report(partial=control().get("diagnostics") == "partial")


class Pool:
    """Takes the trial documents; a trial closes the goal when its text holds `omega`, and fails on `bad_tactic`."""

    async def run_texts(self, texts, want_goal_at=None):
        try:
            with open(TRIALS, encoding="utf-8") as handle:
                recorded = json.load(handle)
        except FileNotFoundError:
            recorded = []
        recorded.extend(texts)
        with open(TRIALS, "w", encoding="utf-8") as handle:
            json.dump(recorded, handle)
        trials = []
        for text, wanted in zip(texts, want_goal_at or [(0, 0)] * len(texts)):
            document = text.split("\n")
            last = document[wanted[0]] if wanted[0] < len(document) else ""
            at = max(last.find("bad_tactic"), 0)
            error = {"severity": 1, "message": "unknown tactic", "range": {"start": {"line": wanted[0], "character": at}, "end": {"line": wanted[0], "character": wanted[1]}}}
            trials.append(
                types.SimpleNamespace(
                    diagnostics=types.SimpleNamespace(items=[error] if "bad_tactic" in last else []),
                    goal=types.SimpleNamespace(status="complete" if "omega" in last else "goals", goals=[] if "omega" in last else [GOAL]),
                )
            )
        return trials


async def require_client_for_file(ctx, file_path: str) -> str:
    # As the real function: relative to the project, and the file must exist.
    target = os.path.realpath(os.path.join(PROJECT, file_path))
    if not target.startswith(PROJECT + os.sep):
        raise ValueError(f"Path {file_path} is outside the Lean project")
    if not os.path.isfile(target):
        raise FileNotFoundError(f"File not found: {file_path}")
    return os.path.relpath(target, PROJECT)


def get_client(ctx):
    return Client()


async def open_synced(ctx, rel: str, wait: bool = False):
    return types.SimpleNamespace(text=Client().content(rel))


for module in (goals, diagnostics, search, attempt_utils):
    module.require_client_for_file = require_client_for_file
    module.get_client = get_client
    module.open_synced = open_synced
attempt_utils.get_scratch_pool = lambda ctx: Pool()


if __name__ == "__main__":
    server.apply_tool_configuration(server.mcp)
    server.mcp.run()
