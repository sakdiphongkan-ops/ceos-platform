#!/usr/bin/env python3
"""Strict point-in-time financial statement utilities for LUNA research.

PIT model:
    period_end   = what period the statement covers
    published_at = when public disclosure became available
    available_at = first trading day allowed for strategy use
    retrieved_at = when LUNA fetched the source for audit/revision tracking

Strict research mode never substitutes retrieved_at for available_at.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Iterable

import pandas as pd


class PointInTimeFinancials:
    DEFAULT_VERSION_COLUMNS = (
        "net_profit",
        "total_assets",
        "total_liabilities",
        "equity",
        "revenue",
        "operating_cash_flow",
        "eps",
        "revenue_q",
        "net_profit_q",
        "revenue_accum",
        "net_profit_accum",
        "adjustment_status",
        "source_hash",
    )

    def __init__(
        self,
        timezone: str = "Asia/Bangkok",
        version_columns: Iterable[str] | None = None,
    ) -> None:
        self.timezone = timezone
        self.version_columns = tuple(
            version_columns or self.DEFAULT_VERSION_COLUMNS
        )

    def normalize_timestamp(self, values: pd.Series) -> pd.Series:
        dt = pd.to_datetime(values, errors="coerce")
        if dt.dt.tz is None:
            return dt.dt.tz_localize(self.timezone)
        return dt.dt.tz_convert(self.timezone)

    def normalize_frame(self, df: pd.DataFrame) -> pd.DataFrame:
        frame = df.copy()
        required = {
            "ticker",
            "period_end",
            "published_at",
            "retrieved_at",
        }
        missing = sorted(required - set(frame.columns))
        if missing:
            raise ValueError(f"Missing required columns: {missing}")

        frame["ticker"] = (
            frame["ticker"].astype(str).str.upper().str.strip()
        )
        frame["period_end"] = pd.to_datetime(
            frame["period_end"], errors="coerce"
        )

        for col in ("published_at", "retrieved_at"):
            frame[col] = self.normalize_timestamp(frame[col])

        if "available_at" in frame.columns:
            frame["available_at"] = self.normalize_timestamp(
                frame["available_at"]
            )

        for col in (
            "period_end",
            "published_at",
            "retrieved_at",
        ):
            if frame[col].isna().any():
                raise ValueError(f"Invalid {col} found")

        return frame

    def load(self, filepath: str | Path) -> pd.DataFrame:
        return self.normalize_frame(pd.read_csv(filepath))

    def version_hash(self, row: pd.Series) -> str:
        payload: list[str] = []
        for col in self.version_columns:
            if col not in row.index:
                continue
            value = row[col]
            if pd.isna(value):
                value = "<NA>"
            payload.append(f"{col}={value}")
        return hashlib.sha256(
            "|".join(payload).encode("utf-8")
        ).hexdigest()

    def normalize_trading_calendar(
        self,
        trading_days: pd.DatetimeIndex | pd.Series,
    ) -> pd.DatetimeIndex:
        if isinstance(trading_days, pd.Series):
            values = trading_days
        else:
            values = pd.Series(trading_days)

        normalized = self.normalize_timestamp(values)
        # Calendar is a market-date calendar, so normalize to local midnight.
        result = (
            pd.DatetimeIndex(normalized.dt.normalize())
            .dropna()
            .drop_duplicates()
            .sort_values()
        )
        if len(result) == 0:
            raise ValueError("EMPTY_TRADING_CALENDAR")
        return result

    def assign_available_at(
        self,
        df: pd.DataFrame,
        trading_days: pd.DatetimeIndex | pd.Series,
        rule: str = "next_trading_day",
    ) -> pd.DataFrame:
        """
        Assign strategy availability from public disclosure time.

        The default research rule is intentionally conservative:
        published_at -> next trading day, regardless of whether the source
        timestamp was before or after the market open.

        This matches a daily-close rebalance assumption and prevents same-day
        use of newly disclosed information.
        """
        if rule != "next_trading_day":
            raise ValueError(f"UNSUPPORTED_PIT_AVAILABILITY_RULE: {rule}")

        out = self.normalize_frame(df)
        calendar = self.normalize_trading_calendar(trading_days)

        dates = out["published_at"].dt.normalize()
        positions = calendar.searchsorted(
            dates + pd.Timedelta(days=1),
            side="left",
        )

        if (positions >= len(calendar)).any():
            raise ValueError(
                "TRADING_CALENDAR_DOES_NOT_EXTEND_PAST_PUBLISHED_DATA"
            )

        out["available_at"] = pd.DatetimeIndex(
            calendar[positions]
        ).to_series(index=out.index).values
        out["available_at_rule"] = rule
        out["information_delay_days"] = (
            out["available_at"].dt.normalize()
            - out["published_at"].dt.normalize()
        ).dt.days

        invalid = out["available_at"] <= out["published_at"]
        if invalid.any():
            raise AssertionError(
                "PIT_AVAILABLE_AT_NOT_AFTER_PUBLISHED_AT"
            )

        return out

    def detect_revisions(self, df: pd.DataFrame) -> pd.DataFrame:
        if df.empty:
            return df.copy()

        out = self.normalize_frame(df)

        if "available_at" not in out.columns:
            raise ValueError(
                "PIT_AVAILABLE_AT_REQUIRED: pass available_at or "
                "call assign_available_at() with a trading calendar"
            )

        invalid = out["available_at"] <= out["published_at"]
        if invalid.any():
            raise ValueError(
                "available_at must be strictly after published_at "
                "under the conservative next-trading-day rule"
            )

        out = out.sort_values(
            [
                "ticker",
                "period_end",
                "available_at",
                "retrieved_at",
            ]
        ).reset_index(drop=True)

        out["version_hash"] = out.apply(
            self.version_hash,
            axis=1,
        )

        # Re-fetching identical financial content is not a new revision.
        out = (
            out.drop_duplicates(
                subset=[
                    "ticker",
                    "period_end",
                    "version_hash",
                ],
                keep="first",
            )
            .reset_index(drop=True)
        )

        out["revision_no"] = (
            out.groupby(
                ["ticker", "period_end"],
                sort=False,
            )
            .cumcount()
            .astype(int)
        )

        out["is_restated"] = out["revision_no"].gt(0)

        out["previous_version_hash"] = (
            out.groupby(
                ["ticker", "period_end"],
                sort=False,
            )["version_hash"]
            .shift(1)
        )

        out["restated_at"] = pd.Series(
            pd.NaT,
            index=out.index,
            dtype=out["available_at"].dtype,
        )

        mask = (
            out["is_restated"]
            & out["previous_version_hash"].notna()
        )

        out.loc[mask, "restated_at"] = out.loc[
            mask,
            "available_at",
        ]

        return out

    def snapshot_asof(
        self,
        df: pd.DataFrame,
        asof: str | pd.Timestamp,
    ) -> pd.DataFrame:
        if df.empty:
            return pd.DataFrame()

        frame = (
            df.copy()
            if "version_hash" in df.columns
            else self.detect_revisions(df)
        )

        if "available_at" not in frame.columns:
            raise ValueError("PIT_AVAILABLE_AT_REQUIRED")

        ts = pd.Timestamp(asof)
        if ts.tzinfo is None:
            ts = ts.tz_localize(self.timezone)
        else:
            ts = ts.tz_convert(self.timezone)

        valid = frame[
            frame["available_at"] <= ts
        ].copy()

        if valid.empty:
            return pd.DataFrame()

        return (
            valid.sort_values("available_at")
            .groupby(
                ["ticker", "period_end"],
                as_index=False,
            )
            .tail(1)
            .reset_index(drop=True)
        )

    def merge_prices(
        self,
        statements: pd.DataFrame,
        prices: pd.DataFrame,
        price_time_col: str = "date",
    ) -> pd.DataFrame:
        """
        Attach the latest PIT-safe statement to each market observation.
        """
        st = (
            statements.copy()
            if "version_hash" in statements.columns
            else self.detect_revisions(statements)
        )
        px = prices.copy()

        if "available_at" not in st.columns:
            raise ValueError("PIT_AVAILABLE_AT_REQUIRED")

        st["available_at"] = self.normalize_timestamp(
            st["available_at"]
        )
        px[price_time_col] = self.normalize_timestamp(
            px[price_time_col]
        )

        st["ticker"] = (
            st["ticker"].astype(str).str.upper().str.strip()
        )
        px["ticker"] = (
            px["ticker"].astype(str).str.upper().str.strip()
        )

        universe = (
            px[[price_time_col, "ticker"]]
            .drop_duplicates()
            .sort_values(["ticker", price_time_col])
        )

        st = st.sort_values(["ticker", "available_at"])

        joined = pd.merge_asof(
            universe,
            st,
            left_on=price_time_col,
            right_on="available_at",
            by="ticker",
            direction="backward",
            allow_exact_matches=True,
        )

        mask = joined["available_at"].notna()
        if mask.any():
            if not (
                joined.loc[mask, price_time_col]
                >= joined.loc[mask, "available_at"]
            ).all():
                raise AssertionError(
                    "LOOK_AHEAD_BIAS_DETECTED"
                )

        return joined

    @staticmethod
    def safe_pct_change(
        old: float,
        new: float,
    ) -> float | None:
        old = float(old)
        new = float(new)
        if old == 0:
            return 0.0 if new == 0 else None
        return (new - old) / abs(old)

    def restatement_impact(
        self,
        df: pd.DataFrame,
    ) -> pd.DataFrame:
        if df.empty:
            return pd.DataFrame()

        frame = (
            df.copy()
            if "revision_no" in df.columns
            else self.detect_revisions(df)
        )

        rows: list[dict] = []

        for (ticker, period_end), group in frame.groupby(
            ["ticker", "period_end"],
            sort=False,
        ):
            group = group.sort_values("revision_no")
            if len(group) < 2:
                continue

            original = group.iloc[0]
            latest = group.iloc[-1]

            original_profit = float(
                original.get("net_profit", 0) or 0
            )
            latest_profit = float(
                latest.get("net_profit", 0) or 0
            )
            original_assets = float(
                original.get("total_assets", 0) or 0
            )
            latest_assets = float(
                latest.get("total_assets", 0) or 0
            )

            rows.append(
                {
                    "ticker": ticker,
                    "period_end": period_end,
                    "original_revision": int(
                        original["revision_no"]
                    ),
                    "latest_revision": int(
                        latest["revision_no"]
                    ),
                    "original_version_hash": original.get(
                        "version_hash"
                    ),
                    "latest_version_hash": latest.get(
                        "version_hash"
                    ),
                    "original_net_profit": original_profit,
                    "restated_net_profit": latest_profit,
                    "profit_change": (
                        latest_profit - original_profit
                    ),
                    "profit_change_pct": self.safe_pct_change(
                        original_profit,
                        latest_profit,
                    ),
                    "original_assets": original_assets,
                    "restated_assets": latest_assets,
                    "assets_change": (
                        latest_assets - original_assets
                    ),
                    "assets_change_pct": self.safe_pct_change(
                        original_assets,
                        latest_assets,
                    ),
                    "restatement_reason": latest.get(
                        "restatement_reason",
                        "Unknown",
                    ),
                    "restated_at": latest.get(
                        "restated_at",
                        pd.NaT,
                    ),
                }
            )

        return pd.DataFrame(rows)


def add_common_financial_factors(
    pit_snapshot: pd.DataFrame,
) -> pd.DataFrame:
    """
    PIT-safe accounting ratios.
    Values are assumed to have already been normalized to THB.
    """
    df = pit_snapshot.copy()

    numeric_cols = (
        "net_profit",
        "total_assets",
        "equity",
        "revenue",
        "operating_cash_flow",
        "net_profit_q",
        "revenue_q",
    )

    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(
                df[col],
                errors="coerce",
            )

    if {"net_profit", "revenue"} <= set(df.columns):
        df["profit_margin"] = (
            df["net_profit"]
            / df["revenue"].replace(0, pd.NA)
        )

    if {"net_profit", "equity"} <= set(df.columns):
        df["roe"] = (
            df["net_profit"]
            / df["equity"].replace(0, pd.NA)
        )

    if {"revenue", "total_assets"} <= set(df.columns):
        df["asset_turnover"] = (
            df["revenue"]
            / df["total_assets"].replace(0, pd.NA)
        )

    if {
        "operating_cash_flow",
        "net_profit",
    } <= set(df.columns):
        df["cash_conversion"] = (
            df["operating_cash_flow"]
            / df["net_profit"].replace(0, pd.NA)
        )

    return df


def validate_pit(
    df: pd.DataFrame,
    max_financial_age_days: int | None = None,
) -> str:
    required = {
        "ticker",
        "date",
        "available_at",
    }
    missing = sorted(required - set(df.columns))
    if missing:
        raise ValueError(
            f"Missing PIT validation columns: {missing}"
        )

    errors: list[str] = []

    leaked = df["available_at"] > df["date"]
    if leaked.any():
        errors.append(
            f"look_ahead_rows={int(leaked.sum())}"
        )

    duplicates = df.duplicated(
        ["ticker", "date"]
    )
    if duplicates.any():
        errors.append(
            f"duplicate_ticker_date_rows={int(duplicates.sum())}"
        )

    negative_age = (
        df["date"] - df["available_at"]
    ).dt.days.lt(0)

    if negative_age.any():
        errors.append(
            f"negative_information_age={int(negative_age.sum())}"
        )

    stale_count=0
    if max_financial_age_days is not None:
        age = (df["date"] - df["available_at"]).dt.days
        stale_count=int((age > max_financial_age_days).fillna(False).sum())

    if errors:
        raise ValueError(
            "PIT validation failed: " + "; ".join(errors)
        )

    return f"PIT validation passed; stale_financial_rows={stale_count}"
