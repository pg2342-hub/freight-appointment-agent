"""Mock TMS and facility calendar. All data is constructed test data."""
import hashlib, json, math
from datetime import datetime, timedelta, date
from pathlib import Path
from zoneinfo import ZoneInfo

WORLD = Path(__file__).resolve().parents[2] / "seed" / "world.json"


class TMS:
    def __init__(self, path=WORLD):
        raw = json.loads(Path(path).read_text())
        self.facilities = {f["id"]: f for f in raw["facilities"]}
        self.loads = raw["loads"]
        self.mph = raw["transit"]["mph"]
        self.dwell = raw["transit"]["dwell_hours"]

    # ---- lookups ----
    def find_by_po(self, po):
        return [l for l in self.loads if po in (l["customer_po"], l["load_no"])]

    def first_open_load_at(self, facility):
        for l in self.loads:
            if facility in (l["delivery"]["facility"], l["pickup"]["facility"]):
                return l
        return None

    # ---- time helpers ----
    def tz(self, fac_id):
        return ZoneInfo(self.facilities[fac_id]["tz"])

    def local(self, fac_id, s):
        """'YYYY-MM-DDTHH:MM' in the facility's own time zone -> aware datetime."""
        return datetime.fromisoformat(s).replace(tzinfo=self.tz(fac_id))

    def fmt(self, fac_id, dt):
        return dt.astimezone(self.tz(fac_id)).strftime("%Y-%m-%dT%H:%M")

    def transit(self, miles):
        return timedelta(hours=self.dwell + math.ceil(miles / self.mph))

    # ---- calendar ----
    def is_open_day(self, fac_id, d: date):
        f = self.facilities[fac_id]
        return d.weekday() in f["days"] and d.isoformat() not in f["holidays"]

    def slots(self, fac_id, start: datetime, days=14, respect_calendar=True, extra_booked=()):
        """Hourly dock slots from `start`'s date onward, in facility local time."""
        f = self.facilities[fac_id]
        tz = self.tz(fac_id)
        o, c = int(f["open"][:2]), int(f["close"][:2])
        booked = set(f["booked"]) | set(extra_booked)
        d0 = start.astimezone(tz).date()
        out = []
        for i in range(days):
            d = d0 + timedelta(days=i)
            if respect_calendar and not self.is_open_day(fac_id, d):
                continue
            for h in range(o, c):
                s = f"{d.isoformat()}T{h:02d}:00"
                if s not in booked:
                    out.append(datetime.fromisoformat(s).replace(tzinfo=tz))
        return out

    # ---- the facility's side of a booking ----
    def confirmation(self, fac_id, local):
        """Confirmation number the facility returns for a booking (deterministic mock)."""
        return fac_id + "-" + hashlib.sha1(f"{fac_id}{local}".encode()).hexdigest()[:5].upper()
