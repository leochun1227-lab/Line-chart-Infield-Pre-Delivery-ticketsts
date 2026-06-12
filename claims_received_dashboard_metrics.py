from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

try:
    import pandas as pd
except ImportError:  # pragma: no cover - only used in lightweight local tests
    pd = None

try:
    import firebase_admin
    from firebase_admin import credentials, db
except ImportError:  # pragma: no cover - Firebase is only required when uploading
    firebase_admin = None
    credentials = None
    db = None


FIREBASE_DB_URL = os.getenv(
    "FIREBASE_DB_URL",
    "https://snowy-hr-report-default-rtdb.asia-southeast1.firebasedatabase.app",
)
FIREBASE_SA_PATH = os.getenv(
    "FIREBASE_SA_PATH",
    r"C:\Users\yan\Desktop\snowy-hr-report-firebase-adminsdk-fbsvc-5dccd921e0.json",
)
FIREBASE_ROOT = os.getenv("FIREBASE_ROOT", "c4cTickets_test")
CLAIMS_RECEIVED_DASHBOARD_ROOT = os.getenv(
    "CLAIMS_RECEIVED_DASHBOARD_ROOT",
    "claimsReceivedDashboard",
)
CLAIMS_RECEIVED_INFIELD_KEYWORDS = [
    x.strip().lower()
    for x in os.getenv(
        "CLAIMS_RECEIVED_INFIELD_KEYWORDS",
        "in field,in-field,infield,field warranty",
    ).split(",")
    if x.strip()
]
CLAIMS_RECEIVED_PRE_DELIVERY_KEYWORDS = [
    x.strip().lower()
    for x in os.getenv(
        "CLAIMS_RECEIVED_PRE_DELIVERY_KEYWORDS",
        "pre delivery,pre-delivery,predelivery,pdi",
    ).split(",")
    if x.strip()
]
CLAIMS_RECEIVED_START_YEAR = int(os.getenv("CLAIMS_RECEIVED_START_YEAR", "2024"))


def firebase_init() -> None:
    if firebase_admin is None or credentials is None:
        raise SystemExit("请先安装 firebase-admin: pip install firebase-admin")
    if getattr(firebase_admin, "_apps", None) and firebase_admin._apps:
        return
    if not os.path.exists(FIREBASE_SA_PATH):
        raise SystemExit("FIREBASE_SA_PATH 私钥文件路径无效")
    if not FIREBASE_DB_URL:
        raise SystemExit("请填写正确的 FIREBASE_DB_URL")

    cred = credentials.Certificate(FIREBASE_SA_PATH)
    firebase_admin.initialize_app(cred, {"databaseURL": FIREBASE_DB_URL})


def firebase_node_to_dict(node: Any) -> Dict[str, Any]:
    if isinstance(node, dict):
        return node
    if isinstance(node, list):
        return {str(i): v for i, v in enumerate(node) if v is not None}
    return {}


def as_clean_str(value: Any) -> str:
    if value is None:
        return ""
    if pd is not None:
        try:
            if pd.isna(value):
                return ""
        except Exception:
            pass
    text = str(value).strip()
    return text


def iso_utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_claim_text(value: Any) -> str:
    text = as_clean_str(value).lower().replace("_", " ").replace("-", " ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def matches_any_keyword(search_text: str, keywords: List[str]) -> bool:
    if not search_text:
        return False
    compact_text = search_text.replace(" ", "")
    for keyword in keywords:
        normalized_keyword = normalize_claim_text(keyword)
        if not normalized_keyword:
            continue
        if normalized_keyword in search_text:
            return True
        if normalized_keyword.replace(" ", "") in compact_text:
            return True
    return False


def classify_claim_received_bucket(ticket_data: Dict[str, Any]) -> str:
    search_fields = [
        "TicketTypeText",
        "TicketType",
        "TicketName",
        "Subject",
        "Name",
        "Category",
        "ServiceCategory",
        "ClaimType",
        "WarrantyClaimType",
        "Claim Type",
        "Warranty Claim Type",
        "Warranty Type",
    ]
    search_values = [
        normalize_claim_text(ticket_data.get(field))
        for field in search_fields
        if field in ticket_data
    ]

    # C4C custom fields can differ between exports. Keep this standalone script
    # tolerant by scanning scalar values as a fallback.
    for value in ticket_data.values():
        if isinstance(value, (str, int, float, bool)) or value is None:
            search_values.append(normalize_claim_text(value))

    search_text = " ".join(x for x in search_values if x)
    if matches_any_keyword(search_text, CLAIMS_RECEIVED_PRE_DELIVERY_KEYWORDS):
        return "preDelivery"
    if matches_any_keyword(search_text, CLAIMS_RECEIVED_INFIELD_KEYWORDS):
        return "inField"
    return ""


def parse_created_on_month(created_on: Any) -> str:
    raw = as_clean_str(created_on)
    if not raw:
        return ""

    match = re.match(r"^(\d{4})[-/](\d{1,2})", raw)
    if match:
        year = int(match.group(1))
        month = int(match.group(2))
        if 1 <= month <= 12:
            return f"{year:04d}-{month:02d}"

    match = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", raw)
    if match:
        day = int(match.group(1))
        month = int(match.group(2))
        year = int(match.group(3))
        if 1 <= day <= 31 and 1 <= month <= 12:
            return f"{year:04d}-{month:02d}"

    match = re.search(r"/Date\((-?\d+)", raw)
    if match:
        try:
            dt = datetime.fromtimestamp(int(match.group(1)) / 1000, tz=timezone.utc)
            return f"{dt.year:04d}-{dt.month:02d}"
        except (OverflowError, OSError, ValueError):
            return ""

    if pd is None:
        return ""
    try:
        dt = pd.to_datetime(raw, errors="coerce", utc=True)
    except Exception:
        return ""
    try:
        if pd.isna(dt):
            return ""
    except Exception:
        return ""
    return f"{dt.year:04d}-{dt.month:02d}"


def month_key_to_label(month_key: str) -> str:
    try:
        dt = datetime.strptime(month_key, "%Y-%m")
        return dt.strftime("%B %Y")
    except ValueError:
        return month_key


def current_year_month(now: Optional[datetime] = None) -> Tuple[int, int]:
    dt = now or datetime.now(timezone.utc)
    return dt.year, dt.month


def year_month_keys(
    year: int,
    now: Optional[datetime] = None,
    latest_data_month: Optional[int] = None,
) -> List[str]:
    current_year, current_month = current_year_month(now)
    if year > current_year:
        return []
    if year == current_year:
        end_month = latest_data_month if latest_data_month else current_month
        end_month = min(max(end_month, 1), current_month)
    else:
        end_month = 12
    return [f"{year:04d}-{month:02d}" for month in range(1, end_month + 1)]


def add_months(month_key: str, delta: int) -> str:
    dt = datetime.strptime(month_key, "%Y-%m")
    year = dt.year + ((dt.month - 1 + delta) // 12)
    month = ((dt.month - 1 + delta) % 12) + 1
    return f"{year:04d}-{month:02d}"


def iter_month_keys(start_month: str, end_month: str) -> List[str]:
    try:
        datetime.strptime(start_month, "%Y-%m")
        datetime.strptime(end_month, "%Y-%m")
    except ValueError:
        return sorted({start_month, end_month})

    out = []
    cursor = start_month
    while cursor <= end_month:
        out.append(cursor)
        cursor = add_months(cursor, 1)
    return out


def extract_ticket_data(node: Any) -> Dict[str, Any]:
    if not isinstance(node, dict):
        return {}
    ticket_data = node.get("ticket", node)
    return ticket_data if isinstance(ticket_data, dict) else {}


def counts_to_month_row(month_key: str, raw_counts: Optional[Dict[str, int]]) -> Dict[str, Any]:
    counts = raw_counts or {}
    in_field = int(counts.get("inField", 0) or 0)
    pre_delivery = int(counts.get("preDelivery", 0) or 0)
    return {
        "month": month_key,
        "label": month_key_to_label(month_key),
        "inField": in_field,
        "preDelivery": pre_delivery,
        "total": in_field + pre_delivery,
    }


def build_series_for_range(
    monthly_counts: Dict[str, Dict[str, int]],
    start_month: str,
    end_month: str,
) -> List[Dict[str, Any]]:
    return [
        counts_to_month_row(month_key, monthly_counts.get(month_key))
        for month_key in iter_month_keys(start_month, end_month)
    ]


def build_claims_received_monthly_payload(
    snapshot: Dict[str, Any],
    start_year: int = CLAIMS_RECEIVED_START_YEAR,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    monthly_counts: Dict[str, Dict[str, int]] = {}
    unmatched = 0
    missing_created_on = 0
    matched = 0

    for node in firebase_node_to_dict(snapshot).values():
        ticket_data = extract_ticket_data(node)
        if not ticket_data:
            continue

        # The dashboard is intentionally calculated from every synced Firebase
        # ticket that can be classified as in-field or pre-delivery; it does not
        # read or filter by criticalRemovedDaily/critical status metrics.
        bucket = classify_claim_received_bucket(ticket_data)
        if not bucket:
            unmatched += 1
            continue

        # CreatedOn is the only date field used for month bucketing.
        month_key = parse_created_on_month(ticket_data.get("CreatedOn"))
        if not month_key:
            missing_created_on += 1
            continue

        year = int(month_key[:4])
        if year < start_year:
            continue

        matched += 1
        if month_key not in monthly_counts:
            monthly_counts[month_key] = {"inField": 0, "preDelivery": 0}
        monthly_counts[month_key][bucket] += 1

    current_year, current_month = current_year_month(now)
    current_month_key = f"{current_year:04d}-{current_month:02d}"
    data_months = sorted(monthly_counts.keys())
    latest_month = data_months[-1] if data_months else current_month_key
    if latest_month > current_month_key:
        latest_month = current_month_key
    min_month = f"{start_year:04d}-01"
    available_years = list(range(start_year, int(latest_month[:4]) + 1))
    latest_month_by_year: Dict[int, int] = {}
    for month_key in monthly_counts:
        year = int(month_key[:4])
        month = int(month_key[5:7])
        latest_month_by_year[year] = max(latest_month_by_year.get(year, 0), month)

    monthly: Dict[str, Dict[str, Any]] = {}
    series_by_year: Dict[str, List[Dict[str, Any]]] = {}

    for year in available_years:
        rows = []
        for month_key in year_month_keys(year, now, latest_month_by_year.get(year)):
            row = counts_to_month_row(month_key, monthly_counts.get(month_key, {}))
            monthly[month_key] = {k: v for k, v in row.items() if k != "month"}
            rows.append(row)
        series_by_year[str(year)] = rows

    default_start_month = f"{current_year:04d}-01"
    default_end_month = latest_month if latest_month.startswith(f"{current_year:04d}-") else current_month_key
    series = build_series_for_range(monthly_counts, default_start_month, default_end_month)

    return {
        "monthly": monthly,
        "series": series,
        "seriesByYear": series_by_year,
        "availableYears": available_years,
        "defaultRange": {"mode": "year", "startMonth": default_start_month, "endMonth": default_end_month},
        "startYear": start_year,
        "latestSyncAt": iso_utc_now(),
        "source": f"{FIREBASE_ROOT}/tickets/*/ticket.CreatedOn",
        "matchedTicketCount": matched,
        "unmatchedTicketCount": unmatched,
        "missingCreatedOnCount": missing_created_on,
        "classification": {
            "inFieldKeywords": CLAIMS_RECEIVED_INFIELD_KEYWORDS,
            "preDeliveryKeywords": CLAIMS_RECEIVED_PRE_DELIVERY_KEYWORDS,
        },
    }


def refresh_claims_received_dashboard() -> Dict[str, Any]:
    if db is None:
        raise SystemExit("请先安装 firebase-admin: pip install firebase-admin")
    firebase_init()
    tickets = firebase_node_to_dict(db.reference(f"{FIREBASE_ROOT}/tickets").get())
    payload = build_claims_received_monthly_payload(tickets)
    db.reference(f"{FIREBASE_ROOT}/{CLAIMS_RECEIVED_DASHBOARD_ROOT}").set(payload)
    db.reference(f"{FIREBASE_ROOT}/claimsReceivedLatestSyncAt").set(payload["latestSyncAt"])
    return payload


def main() -> None:
    payload = refresh_claims_received_dashboard()
    print(
        "Claims received dashboard refreshed: "
        f"months={len(payload['series'])} "
        f"matched={payload['matchedTicketCount']} "
        f"unmatched={payload['unmatchedTicketCount']} "
        f"missingCreatedOn={payload['missingCreatedOnCount']}"
    )


if __name__ == "__main__":
    main()
