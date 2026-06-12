from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List

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


def iter_month_keys(start_month: str, end_month: str) -> List[str]:
    try:
        start = datetime.strptime(start_month, "%Y-%m")
        end = datetime.strptime(end_month, "%Y-%m")
    except ValueError:
        return sorted({start_month, end_month})

    out = []
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month):
        out.append(f"{year:04d}-{month:02d}")
        month += 1
        if month > 12:
            year += 1
            month = 1
    return out


def extract_ticket_data(node: Any) -> Dict[str, Any]:
    if not isinstance(node, dict):
        return {}
    ticket_data = node.get("ticket", node)
    return ticket_data if isinstance(ticket_data, dict) else {}


def build_claims_received_monthly_payload(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    monthly: Dict[str, Dict[str, int]] = {}
    unmatched = 0
    missing_created_on = 0
    matched = 0

    for node in firebase_node_to_dict(snapshot).values():
        ticket_data = extract_ticket_data(node)
        if not ticket_data:
            continue

        bucket = classify_claim_received_bucket(ticket_data)
        if not bucket:
            unmatched += 1
            continue

        month_key = parse_created_on_month(ticket_data.get("CreatedOn"))
        if not month_key:
            missing_created_on += 1
            continue

        matched += 1
        if month_key not in monthly:
            monthly[month_key] = {"inField": 0, "preDelivery": 0}
        monthly[month_key][bucket] += 1

    series = []
    month_keys = iter_month_keys(min(monthly.keys()), max(monthly.keys())) if monthly else []
    for month_key in month_keys:
        raw_counts = monthly.get(month_key, {"inField": 0, "preDelivery": 0})
        in_field = int(raw_counts.get("inField", 0) or 0)
        pre_delivery = int(raw_counts.get("preDelivery", 0) or 0)
        monthly[month_key] = {
            "label": month_key_to_label(month_key),
            "inField": in_field,
            "preDelivery": pre_delivery,
            "total": in_field + pre_delivery,
        }
        series.append({"month": month_key, **monthly[month_key]})

    return {
        "monthly": monthly,
        "series": series,
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
