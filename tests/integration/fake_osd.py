#!/usr/bin/env python3
"""A stand-in for plasmashell's OSD service on a nested session's private bus (never the user's bus).

Owns org.kde.plasmashell and exports /org/kde/osdService with org.kde.osdService.showText(s icon, s text), the
method Plastile calls (introspected on plasmashell 6.7.5). Each call is appended to the record file as one JSON
line {"t": <monotonic s>, "icon": ..., "text": ...}. Prints "ready" once the name is owned.

Usage: fake_osd.py <record file>   (DBUS_SESSION_BUS_ADDRESS must name the private bus)
"""
from __future__ import annotations

import json
import os
import sys
import time

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

SERVICE, PATH, IFACE = "org.kde.plasmashell", "/org/kde/osdService", "org.kde.osdService"


class Osd(dbus.service.Object):
    def __init__(self, bus, record: str):
        super().__init__(bus, PATH)
        self.record = record

    @dbus.service.method(IFACE, in_signature="ss", out_signature="")
    def showText(self, icon, text):  # noqa: N802  (D-Bus name)
        with open(self.record, "a") as f:
            f.write(json.dumps({"t": time.monotonic(), "icon": str(icon), "text": str(text)}) + "\n")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    addr = os.environ.get("DBUS_SESSION_BUS_ADDRESS", "")
    if "/run/user/" in addr:  # the user's own session bus: refuse
        print("refusing to run on the user's session bus", file=sys.stderr)
        return 3
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.bus.BusConnection(addr)
    name = dbus.service.BusName(SERVICE, bus, do_not_queue=True)  # noqa: F841  (kept alive)
    Osd(bus, sys.argv[1])
    print("ready", flush=True)
    GLib.MainLoop().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
