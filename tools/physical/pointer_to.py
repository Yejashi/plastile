#!/usr/bin/env python3
"""Move the pointer of the live session onto one output for the latency runs (P6), through a temporary
uinput relative pointer named plastile-pointer. It only moves: no buttons are ever pressed. The device
exists for the duration of the call.

    python3 tools/physical/pointer_to.py left|right|DX     # DX: relative steps after pushing to the left edge

`left` pushes the pointer far left and up (it clamps on the leftmost output), `right` far right and up.
A number pushes left first and then moves right in small slow steps (low speeds keep libinput's
acceleration near 1:1). Prints KWin's activeOutputName() afterwards (follows the mouse by default).
Refuses to run unless the session is a local Wayland session (same guard idea as plastile-keytap).
"""
from __future__ import annotations

import fcntl, os, struct, subprocess, sys, time

UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_RELBIT = 0x40045564, 0x40045565, 0x40045566
UI_DEV_SETUP, UI_DEV_CREATE, UI_DEV_DESTROY = 0x405C5503, 0x5501, 0x5502
EV_SYN, EV_KEY, EV_REL, REL_X, REL_Y, BTN_LEFT = 0, 1, 2, 0, 1, 0x110


def ev(fd: int, t: int, c: int, v: int) -> None:
    os.write(fd, struct.pack("llHHi", 0, 0, t, c, v))


def move(fd: int, dx: int, dy: int) -> None:
    ev(fd, EV_REL, REL_X, dx); ev(fd, EV_REL, REL_Y, dy); ev(fd, EV_SYN, 0, 0)


def main() -> int:
    if os.environ.get("XDG_SESSION_TYPE") != "wayland" or os.geteuid() == 0:
        print("refusing: needs the user's own Wayland session", file=sys.stderr)
        return 3
    arg = sys.argv[1] if len(sys.argv) > 1 else "left"
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    try:
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY); fcntl.ioctl(fd, UI_SET_KEYBIT, BTN_LEFT)  # libinput: a pointer has a button
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_REL); fcntl.ioctl(fd, UI_SET_RELBIT, REL_X); fcntl.ioctl(fd, UI_SET_RELBIT, REL_Y)
        fcntl.ioctl(fd, UI_DEV_SETUP, struct.pack("HHHH80sI", 3, 0x1234, 0x5679, 1, b"plastile-pointer", 0))
        fcntl.ioctl(fd, UI_DEV_CREATE)
        time.sleep(1.0)  # let the compositor pick the device up
        sign = 1 if arg == "right" else -1
        for _ in range(120):
            move(fd, sign * 200, -200); time.sleep(0.004)
        if arg not in ("left", "right"):
            steps = int(arg)
            for _ in range(steps // 5):
                move(fd, 5, 0); time.sleep(0.02)
            for _ in range(60):  # and down into the middle of the height
                move(fd, 0, 5); time.sleep(0.02)
        else:
            for _ in range(60):
                move(fd, 0, 5); time.sleep(0.02)
        time.sleep(0.3)
        fcntl.ioctl(fd, UI_DEV_DESTROY)
    finally:
        os.close(fd)
    out = subprocess.run(["qdbus6", "org.kde.KWin", "/KWin", "org.kde.KWin.activeOutputName"], capture_output=True, text=True)
    print(out.stdout.strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
