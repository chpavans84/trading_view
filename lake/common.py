"""Shared config + DuckDB helpers for the Python Silver/Gold lake layers.

Bronze (T1) is produced by Node (scripts/dump-oltp-to-bronze.mjs). Silver (T2) and
Gold (T3) are Python + DuckDB (this package). See docs/ARCHITECTURE.md.
"""
import os
import glob
import duckdb

ARCHIVE   = os.environ.get("ARCHIVE_ROOT", "/Volumes/Archive")
BRONZE    = os.environ.get("BRONZE_ROOT", f"{ARCHIVE}/bronze/oltp")
SILVER    = os.environ.get("SILVER_ROOT", f"{ARCHIVE}/silver")
GOLD      = os.environ.get("GOLD_ROOT",   f"{ARCHIVE}/gold")
FLATFILES = f"{ARCHIVE}/polygon-flatfiles/us_stocks_sip"
NEWS      = f"{ARCHIVE}/benzinga-news"
TZ        = "America/New_York"


def connect():
    con = duckdb.connect()
    con.execute(f"SET TimeZone='{TZ}'")
    return con


def bronze_tables():
    """Auto-discover Bronze tables that actually have parquet (schema-flexible)."""
    out = []
    for d in sorted(glob.glob(f"{BRONZE}/*/")):
        name = os.path.basename(d.rstrip("/"))
        if glob.glob(f"{d}**/*.parquet", recursive=True):
            out.append(name)
    return out


def columns(con, parquet_glob):
    rows = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{parquet_glob}', union_by_name=true)"
    ).fetchall()
    return [r[0] for r in rows]


def write_partitioned(con, select_sql, dest_dir, partition):
    os.makedirs(dest_dir, exist_ok=True)
    con.execute(
        f"COPY ({select_sql}) TO '{dest_dir}' "
        f"(FORMAT PARQUET, PARTITION_BY ({partition}), OVERWRITE_OR_IGNORE)"
    )
    return con.execute(
        f"SELECT count(*) FROM read_parquet('{dest_dir}/**/*.parquet')"
    ).fetchone()[0]


def write_file(con, select_sql, dest_file):
    os.makedirs(os.path.dirname(dest_file), exist_ok=True)
    con.execute(f"COPY ({select_sql}) TO '{dest_file}' (FORMAT PARQUET)")
    return con.execute(
        f"SELECT count(*) FROM read_parquet('{dest_file}')"
    ).fetchone()[0]
