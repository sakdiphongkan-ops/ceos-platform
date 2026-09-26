#!/usr/bin/env python3
"""Point-in-time financial statement utilities for LUNA research."""
from __future__ import annotations
import hashlib
from pathlib import Path
from typing import Iterable
import pandas as pd

class PointInTimeFinancials:
    DEFAULT_VERSION_COLUMNS = ("net_profit","total_assets","total_liabilities","equity","revenue","operating_cash_flow","eps")
    def __init__(self, timezone: str="Asia/Bangkok", version_columns: Iterable[str] | None=None) -> None:
        self.timezone=timezone
        self.version_columns=tuple(version_columns or self.DEFAULT_VERSION_COLUMNS)

    def normalize_timestamp(self, values: pd.Series) -> pd.Series:
        dt=pd.to_datetime(values, errors="coerce")
        if dt.dt.tz is None:
            return dt.dt.tz_localize(self.timezone)
        return dt.dt.tz_convert(self.timezone)

    def normalize_frame(self, df: pd.DataFrame) -> pd.DataFrame:
        frame=df.copy()
        required={"ticker","period_end","published_at","retrieved_at"}
        missing=sorted(required-set(frame.columns))
        if missing: raise ValueError(f"Missing required columns: {missing}")
        frame["ticker"]=frame["ticker"].astype(str).str.upper().str.strip()
        frame["period_end"]=pd.to_datetime(frame["period_end"], errors="coerce")
        for col in ("published_at","retrieved_at"):
            frame[col]=self.normalize_timestamp(frame[col])
        frame["available_at"]=(
            self.normalize_timestamp(frame["available_at"])
            if "available_at" in frame.columns else frame["retrieved_at"]
        )
        for col in ("period_end","published_at","retrieved_at","available_at"):
            if frame[col].isna().any(): raise ValueError(f"Invalid {col} found")
        bad=frame["available_at"]<frame["published_at"]
        if bad.any():
            raise ValueError("available_at cannot be earlier than published_at")
        return frame

    def load(self, filepath: str | Path) -> pd.DataFrame:
        return self.normalize_frame(pd.read_csv(filepath))

    def version_hash(self, row: pd.Series) -> str:
        payload=[]
        for col in self.version_columns:
            if col not in row.index: continue
            value=row[col]
            if pd.isna(value): value="<NA>"
            payload.append(f"{col}={value}")
        return hashlib.sha256("|".join(payload).encode("utf-8")).hexdigest()

    def detect_revisions(self, df: pd.DataFrame) -> pd.DataFrame:
        if df.empty: return df.copy()
        out=self.normalize_frame(df)
        out=out.sort_values(["ticker","period_end","available_at","retrieved_at"]).reset_index(drop=True)
        out["version_hash"]=out.apply(self.version_hash,axis=1)
        out=out.drop_duplicates(["ticker","period_end","version_hash"],keep="first").reset_index(drop=True)
        out["revision_no"]=out.groupby(["ticker","period_end"],sort=False).cumcount().astype(int)
        out["is_restated"]=out["revision_no"].gt(0)
        out["previous_version_hash"]=out.groupby(["ticker","period_end"],sort=False)["version_hash"].shift(1)
        out["restated_at"]=pd.Series(pd.NaT,index=out.index,dtype=out["available_at"].dtype)
        mask=out["is_restated"] & out["previous_version_hash"].notna()
        out.loc[mask,"restated_at"]=out.loc[mask,"available_at"]
        return out

    def snapshot_asof(self, df: pd.DataFrame, asof: str | pd.Timestamp) -> pd.DataFrame:
        if df.empty: return pd.DataFrame()
        frame=df.copy() if "version_hash" in df.columns else self.detect_revisions(df)
        ts=pd.Timestamp(asof)
        ts=ts.tz_localize(self.timezone) if ts.tzinfo is None else ts.tz_convert(self.timezone)
        valid=frame[frame["available_at"]<=ts]
        if valid.empty: return pd.DataFrame()
        return valid.sort_values("available_at").groupby(["ticker","period_end"],as_index=False).tail(1).reset_index(drop=True)

    def merge_prices(self, statements: pd.DataFrame, prices: pd.DataFrame, price_time_col: str="date") -> pd.DataFrame:
        st=statements.copy() if "version_hash" in statements.columns else self.detect_revisions(statements)
        px=prices.copy()
        st["available_at"]=self.normalize_timestamp(st["available_at"])
        px[price_time_col]=self.normalize_timestamp(px[price_time_col])
        st["ticker"]=st["ticker"].astype(str).str.upper().str.strip()
        px["ticker"]=px["ticker"].astype(str).str.upper().str.strip()
        universe=px[[price_time_col,"ticker"]].drop_duplicates().sort_values(["ticker",price_time_col])
        st=st.sort_values(["ticker","available_at"])
        joined=pd.merge_asof(universe,st,left_on=price_time_col,right_on="available_at",by="ticker",direction="backward",allow_exact_matches=True)
        mask=joined["available_at"].notna()
        if mask.any() and not (joined.loc[mask,price_time_col]>=joined.loc[mask,"available_at"]).all():
            raise AssertionError("LOOK_AHEAD_BIAS_DETECTED")
        return joined

    @staticmethod
    def safe_pct_change(old: float,new: float) -> float | None:
        old=float(old); new=float(new)
        if old==0: return 0.0 if new==0 else None
        return (new-old)/abs(old)

    def restatement_impact(self, df: pd.DataFrame) -> pd.DataFrame:
        if df.empty: return pd.DataFrame()
        frame=df.copy() if "revision_no" in df.columns else self.detect_revisions(df)
        rows=[]
        for (ticker,period_end), group in frame.groupby(["ticker","period_end"],sort=False):
            group=group.sort_values("revision_no")
            if len(group)<2: continue
            original,latest=group.iloc[0],group.iloc[-1]
            op=float(original.get("net_profit",0) or 0); lp=float(latest.get("net_profit",0) or 0)
            oa=float(original.get("total_assets",0) or 0); la=float(latest.get("total_assets",0) or 0)
            rows.append({
                "ticker":ticker,"period_end":period_end,
                "original_revision":int(original["revision_no"]),
                "latest_revision":int(latest["revision_no"]),
                "original_version_hash":original.get("version_hash"),
                "latest_version_hash":latest.get("version_hash"),
                "original_net_profit":op,"restated_net_profit":lp,
                "profit_change":lp-op,"profit_change_pct":self.safe_pct_change(op,lp),
                "original_assets":oa,"restated_assets":la,
                "assets_change":la-oa,"assets_change_pct":self.safe_pct_change(oa,la),
                "restatement_reason":latest.get("restatement_reason","Unknown"),
                "restated_at":latest.get("restated_at",pd.NaT),
            })
        return pd.DataFrame(rows)

def add_common_financial_factors(pit_snapshot: pd.DataFrame) -> pd.DataFrame:
    df=pit_snapshot.copy()
    for col in ("net_profit","total_assets","equity","revenue","operating_cash_flow"):
        if col in df.columns: df[col]=pd.to_numeric(df[col],errors="coerce")
    if {"net_profit","revenue"}<=set(df.columns):
        df["profit_margin"]=df["net_profit"]/df["revenue"].replace(0,pd.NA)
    if {"net_profit","equity"}<=set(df.columns):
        df["roe"]=df["net_profit"]/df["equity"].replace(0,pd.NA)
    if {"revenue","total_assets"}<=set(df.columns):
        df["asset_turnover"]=df["revenue"]/df["total_assets"].replace(0,pd.NA)
    if {"operating_cash_flow","net_profit"}<=set(df.columns):
        df["cash_conversion"]=df["operating_cash_flow"]/df["net_profit"].replace(0,pd.NA)
    return df
