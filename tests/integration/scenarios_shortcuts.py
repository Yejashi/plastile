"""Default key bindings (docs/user/SHORTCUTS.md): real key presses reach Plastile.

Every default sequence in src/core/commands.ts is pressed with real keyboard events
injected through KWin's EIS endpoint (libei, tools/input) into a nested KWin with the
default (US) keymap. The oracle for "reached Plastile" is Plastile's own dispatch log at
debug level (one `plastile debug command {"command":"<id>"...}` line per dispatched
command): this checks key routing only, not what the command did. A second check reads the
nested session's kglobalshortcutsrc and reports any non-Plastile action registered with
one of Plastile's default sequences (KGlobalAccel accepts such duplicates silently).

Limits: only KWin and what runs in the nested session register shortcuts here; software
such as Spectacle is not installed in every environment (the Spectacle collision with
Meta+Shift+S is documented in SHORTCUTS.md and rejected by tests/core/package.test.ts).
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from harness import ROOT, Input, Session
from scenarios import Checks, Skipped, scenario

# linux/input-event-codes.h
KEYS = {chr(c): code for c, code in zip(range(ord("A"), ord("Z") + 1),
        (30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44))}
KEYS.update({"=": 13, "-": 12, "Space": 57, "Return": 28, "Tab": 15, "Escape": 1})
MODS = {"Meta": 125, "Shift": 42, "Ctrl": 29, "Alt": 56}
SPEC = re.compile(r'\{ id: "([^"]+)", text: "[^"]*", sequence: "([^"]*)" \}')


def defaults() -> list[tuple[str, str]]:
    text = (ROOT / "src/core/commands.ts").read_text()
    return [(i, s) for i, s in SPEC.findall(text) if s]


def codes(seq: str) -> tuple[list[int], int]:
    parts = seq.split("+")
    if seq.endswith("+") or "" in parts:
        raise ValueError(f"cannot press {seq!r}")
    *mods, key = parts
    return [MODS[m] for m in mods], KEYS[key]


def registry(path: Path) -> list[tuple[str, str, list[str]]]:
    """(group, action, sequences) for every kglobalshortcutsrc entry (active and default fields)."""
    out, group = [], ""
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        if line.startswith("["):
            group = line.strip("[]")
            continue
        if "=" not in line or line.startswith("_k_friendly_name"):
            continue
        action, value = line.split("=", 1)
        fields = value.split(",")
        seqs = [s for f in fields[:2] for s in f.split("\t") if s and s != "none"]
        out.append((group, action, seqs))
    return out


@scenario("shortcuts-defaults-real-input")
def shortcuts_defaults(out: Path, c: Checks):
    binds = defaults()
    c("defaults parsed from commands.ts", len(binds) >= 10, len(binds))
    with Session(out, config={"diagnostics": "debug"}) as s:
        s.spawn(1); s.spawn(2)
        s.load(); s.settle()
        try:
            inp = Input(s)
        except Exception as exc:  # no EIS endpoint or injector here
            raise Skipped(f"libei input injector unavailable: {exc}")
        reached, missed = [], []
        try:
            order = [b for b in binds if b[0] != "plastile.runtime.toggle-suspend"] + \
                    [b for b in binds if b[0] == "plastile.runtime.toggle-suspend"] * 2
            for cid, seq in order:
                mods, key = codes(seq)
                off = s.kw.mark()
                for m in mods:
                    inp.do(f"key {m} down")
                inp.do(f"key {key} down", f"key {key} up")
                for m in reversed(mods):
                    inp.do(f"key {m} up")
                try:
                    s.kw.wait_log(r'plastile debug command \{"command":"' + re.escape(cid) + '"', 2.0, off)
                    reached.append((cid, seq))
                except Exception:
                    missed.append((cid, seq))
                time.sleep(0.05)
        finally:
            inp.close()
        c("every default binding reaches Plastile (real key events, US keymap)", not missed,
          {"missed": missed, "reached": len(reached)})
        time.sleep(0.5)
        reg = registry(s.kw.root / "config/kglobalshortcutsrc")
        mine = {seq for _, seq in binds}
        clashes = [(g, a, q) for g, a, seqs in reg if not a.startswith("plastile.") for q in seqs if q in mine]
        c("no other registered action holds a Plastile default (nested registry)", bool(reg) and not clashes,
          {"entries": len(reg), "clashes": clashes})
        (out / "shortcuts.json").write_text(json.dumps({"reached": reached, "missed": missed, "registryEntries": len(reg),
                                                        "clashes": clashes}, indent=1))
