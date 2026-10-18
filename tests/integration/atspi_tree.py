"""Read one application window's accessibility tree (AT-SPI) and print it as JSON.

Usage (inside a nested session's environment): python3 -I atspi_tree.py PID WINDOW_NAME

Read-only: it locates widgets and reads their state (name, value, checked, enabled) for
scenarios that then act with real input (libei). It never calls an AT-SPI action or sets a
value. Extents are window-relative (Atspi.CoordType.WINDOW); a Wayland client does not know
its screen position, so callers add KWin's client geometry for that window.

Output: [{"role", "name", "ext": [x, y, w, h] | null, "value": float | null,
          "states": [...], "ancestors": [[role, name], ...]}, ...] or {"error": ...}.
"""
from __future__ import annotations

import json
import sys

STATES = ("checked", "enabled", "focused", "showing", "visible", "sensitive")


def main() -> int:
    try:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
    except (ImportError, ValueError) as exc:
        print(json.dumps({"error": f"no AT-SPI bindings: {exc}"}))
        return 0
    pid, window = int(sys.argv[1]), sys.argv[2]
    desk = Atspi.get_desktop(0)
    out: list[dict] = []

    def walk(node, ancestors: list[list[str]]) -> None:
        try:
            role, name = node.get_role_name(), node.get_name() or ""
        except Exception:  # noqa: BLE001  (a node can vanish while we walk)
            return
        entry: dict = {"role": role, "name": name, "ext": None, "value": None, "states": [], "ancestors": ancestors}
        try:
            comp = node.get_component_iface()
            if comp is not None:
                e = comp.get_extents(Atspi.CoordType.WINDOW)
                entry["ext"] = [e.x, e.y, e.width, e.height]
            val = node.get_value_iface()
            if val is not None:
                entry["value"] = val.get_current_value()
            ss = node.get_state_set()
            entry["states"] = [s for s in STATES if ss.contains(getattr(Atspi.StateType, s.upper()))]
        except Exception:  # noqa: BLE001
            pass
        out.append(entry)
        for i in range(node.get_child_count()):
            child = node.get_child_at_index(i)
            if child is not None:
                walk(child, ancestors + [[role, name]])

    for i in range(desk.get_child_count()):
        app = desk.get_child_at_index(i)
        try:
            if app is None or app.get_process_id() != pid:
                continue
        except Exception:  # noqa: BLE001
            continue
        for j in range(app.get_child_count()):
            top = app.get_child_at_index(j)
            if top is not None and top.get_name() == window:
                walk(top, [])
                print(json.dumps(out))
                return 0
    print(json.dumps({"error": f"no window {window!r} for pid {pid}"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
