from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "claims_received_dashboard_metrics.py"


def install_import_stubs() -> None:
    """Provide tiny stubs for optional runtime dependencies during unit tests."""
    pandas = types.ModuleType("pandas")
    pandas.isna = lambda value: value is None
    pandas.to_datetime = lambda *args, **kwargs: None
    pandas.DataFrame = object

    pyodbc = types.ModuleType("pyodbc")

    firebase_admin = types.ModuleType("firebase_admin")
    firebase_admin._apps = []
    firebase_admin.initialize_app = lambda *args, **kwargs: None
    firebase_admin.credentials = types.ModuleType("firebase_admin.credentials")
    firebase_admin.credentials.Certificate = object
    firebase_admin.db = types.ModuleType("firebase_admin.db")
    firebase_admin.exceptions = types.ModuleType("firebase_admin.exceptions")
    firebase_admin.exceptions.InvalidArgumentError = type("InvalidArgumentError", (Exception,), {})

    modules = {
        "pandas": pandas,
        "pyodbc": pyodbc,
        "firebase_admin": firebase_admin,
        "firebase_admin.credentials": firebase_admin.credentials,
        "firebase_admin.db": firebase_admin.db,
        "firebase_admin.exceptions": firebase_admin.exceptions,
    }
    for name, module in modules.items():
        sys.modules.setdefault(name, module)


def load_ticket_sync_module():
    install_import_stubs()
    spec = importlib.util.spec_from_file_location("ticket_sync", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ClaimsReceivedDashboardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.module = load_ticket_sync_module()

    def test_build_monthly_payload_counts_buckets_and_fills_empty_months(self) -> None:
        snapshot = {
            "100": {"ticket": {"TicketName": "In Field Warranty Claim", "CreatedOn": "2025-01-15T08:00:00Z"}},
            "101": {"ticket": {"Warranty Claim Type": "Pre-Delivery Warranty Claim", "CreatedOn": "2025-01-20"}},
            "102": {"ticket": {"TicketTypeText": "In-Field", "CreatedOn": "2025-03-01T00:00:00Z"}},
            "103": {"ticket": {"TicketName": "Pre Delivery", "CreatedOn": "2025-03-22T00:00:00Z"}},
        }

        payload = self.module.build_claims_received_monthly_payload(snapshot)

        self.assertEqual(
            payload["series"],
            [
                {"month": "2025-01", "label": "January 2025", "inField": 1, "preDelivery": 1, "total": 2},
                {"month": "2025-02", "label": "February 2025", "inField": 0, "preDelivery": 0, "total": 0},
                {"month": "2025-03", "label": "March 2025", "inField": 1, "preDelivery": 1, "total": 2},
            ],
        )
        self.assertEqual(payload["unmatchedTicketCount"], 0)
        self.assertEqual(payload["missingCreatedOnCount"], 0)

    def test_custom_scalar_field_classifies_claim_type(self) -> None:
        self.assertEqual(
            self.module.classify_claim_received_bucket({"CustomWarrantyField": "Pre Delivery Warranty Claims"}),
            "preDelivery",
        )
        self.assertEqual(
            self.module.classify_claim_received_bucket({"AnotherCustomField": "infield warranty"}),
            "inField",
        )

    def test_parse_created_on_month_supports_common_formats(self) -> None:
        self.assertEqual(self.module.parse_created_on_month("2026-06-12T09:15:00Z"), "2026-06")
        self.assertEqual(self.module.parse_created_on_month("/Date(1735689600000)/"), "2025-01")
        self.assertEqual(self.module.parse_created_on_month(""), "")


if __name__ == "__main__":
    unittest.main()
