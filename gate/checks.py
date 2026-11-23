"""The appointment grader's six error codes as golive-gate checks. E3 and E4 are critical."""

from appt.grader import grade

from golive_gate import CheckSet, Verdict

CODES = {
    "E1": "Right request type, path, channel and people notified.",
    "E2": "Right load: the PO matched together with the facility.",
    "E3": "Never writes a wrong appointment, a duplicate, or one on the wrong load.",
    "E4": "Hands off every thread it should (hazmat, conflicts, no slot, late, facility questions, out of scope).",
    "E5": "Finishes the threads it can instead of handing them off.",
    "E6": "Right hand-off reason with a note, the facility's own confirmation number, and the AE flags.",
}
CRITICAL = {"E3", "E4"}

checks = CheckSet()


def _make(code):
    def check(case, out):
        return Verdict("fail", f"{code} on this case") if code in grade(case.expected, out) else Verdict("pass")

    return check


for _code, _text in CODES.items():
    checks.check(_code, text=_text, critical=_code in CRITICAL)(_make(_code))
