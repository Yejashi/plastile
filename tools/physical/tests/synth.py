"""Synthetic fixture/keytap logs for the physical-kit unit tests (no desktop needed)."""
from __future__ import annotations

MS = 1_000_000
REFRESH_60 = 16_666_666


class FakeFixture:
    """Builds a plastile-fixture style event list with consistent serials and buffer seqs."""

    def __init__(self, name: str = "fixture-1", width: int = 400, height: int = 300, refresh_ns: int = REFRESH_60,
                 same_clock: bool = True, t0: int = 1_000 * MS, activated: bool = True):
        self.name = name
        self.events: list[dict] = [{"ev": "presentation_clock", "clk_id": 1, "name": "CLOCK_MONOTONIC",
                                    "same_as_log_clock": same_clock, "t_ns": t0}]
        self.serial = 0
        self.seq = 0
        self.refresh_ns = refresh_ns
        self.size = (width, height)
        self.activated = activated
        self.configure(t0 + MS, width, height, activated=activated)

    def configure(self, t: int, width: int, height: int, *, activated: bool | None = None, commit_after: int = 200_000,
                  present_after: int | None = 4 * MS, discard: bool = False, ack: bool = True) -> int:
        """configure at t; commit (ack) after commit_after; presented after present_after (None: never)."""
        if activated is not None:
            self.activated = activated
        self.serial += 1
        states = ["activated"] if self.activated else []
        self.events.append({"ev": "configure", "win": "main", "serial": self.serial, "width": width, "height": height,
                            "states": states, "t_ns": t})
        if not ack:
            return self.serial
        self.seq += 1
        w = width or self.size[0]
        h = height or self.size[1]
        self.size = (w, h)
        tc = t + commit_after
        self.events.append({"ev": "commit", "win": "main", "seq": self.seq, "width": w, "height": h,
                            "serial": self.serial, "reason": "configure", "t_ns": tc})
        if discard:
            self.events.append({"ev": "discarded", "win": "main", "seq": self.seq, "t_ns": tc + MS})
        elif present_after is not None:
            pt = tc + present_after
            self.events.append({"ev": "presented", "win": "main", "seq": self.seq, "present_ns": pt,
                                "refresh_ns": self.refresh_ns, "t_ns": pt + 100_000})
        return self.serial


def tap(i: int, t: int, write_ns: int = 20_000) -> dict:
    return {"ev": "tap", "id": f"t{i}", "mods": [125, 42], "key": 49, "t_input_ns": t, "t_write_end_ns": t + write_ns,
            "t_release_ns": t + 12 * MS}


def record(run: str, value_ns: int, *, workload: str = "P03-ratio", condition: str = "plastile", sample: int = 0,
           success: bool = True, warmup: bool = False, refresh_ns: int = REFRESH_60, hz: int = 60,
           layer: str = "synthetic", windows: int = 4, **provenance) -> dict:
    """A minimal summarizer input record (provenance: environmentId, implementationCommit, motion, ...)."""
    return {**provenance, "runId": run, "workload": workload, "condition": condition, "layer": layer, "outputName": "DP-1",
            "refreshHzDeclared": hz, "windowCount": windows, "sample": sample, "warmup": warmup, "success": success,
            "failureReason": None if success else "no configure in the attribution window",
            "inputToFirstPresentNs": value_ns if success else None,
            "inputToSettledNs": (value_ns + 2 * MS) if success else None,
            "inputToFinalCommitPresentNs": (value_ns + 2 * MS) if success else None,
            "refreshNsObserved": refresh_ns if success else None}
