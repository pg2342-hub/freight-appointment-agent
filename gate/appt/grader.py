"""Grade one proposal against a case's expected outcome.

Error codes:
  E1 wrong request type or path      E2 missing or wrong field (load, PO, facility); a booking on the wrong load also counts as E3
  E3 wrong appointment written (critical)   E4 should have handed off and did not (critical)
  E5 handed off when it could have finished E6 correct, but the log or reason is unclear
"""
from appt.tms import TMS

CRITICAL = {"E3", "E4"}
_TMS = TMS()


def tms_confirmation(p):
    last = p["appointments"][-1]
    return _TMS.confirmation(last["facility"], last["local"])


def _appts(p):
    return [(a["facility"], a["local"]) for a in p.get("appointments", [])]


def grade(expected, p):
    errs = []
    ea, pa = expected["action"], p.get("action")
    if ea == "handoff":
        if pa != "handoff":
            errs.append("E4")
        else:
            if p.get("to") != expected["to"]:
                errs.append("E1")
            if p.get("reason") != expected["reason"] or not p.get("log"):
                errs.append("E6")
        return sorted(set(errs))
    if pa == "handoff":
        return ["E5"]
    if p.get("load") != expected["load"]:
        errs.append("E2")
        if pa in ("book", "enter_existing"):
            errs.append("E3")          # an appointment written to the wrong load is a wrong write
    if ea == "record_fcfs":
        if pa != "record_fcfs":
            errs.append("E1")
    elif ea == "enter_existing":
        if pa == "book":
            errs.append("E3")          # duplicate booking
        elif _appts(p) != _appts(expected):
            errs.append("E3")
    elif ea == "book":
        if pa != "book":
            errs.append("E1")
        elif _appts(p) != _appts(expected):
            errs.append("E3")
        else:
            if p.get("channel") != expected["channel"]:
                errs.append("E1")
            if "attempts" in expected and p.get("attempts") != expected["attempts"]:
                errs.append("E1")
            if p.get("confirmation") != tms_confirmation(p):
                errs.append("E6")      # confirmation must be the one the facility returned
            if not set(expected.get("flags", [])) <= set(p.get("flags", [])):
                errs.append("E6")
    if not set(expected.get("notify", [])) <= set(p.get("notify", [])):
        errs.append("E1")
    return sorted(set(errs))
