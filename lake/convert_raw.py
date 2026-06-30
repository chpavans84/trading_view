"""Heavy raw→Parquet conversion for market data (minute_aggs, trades).

Resumable (skips day-files already converted) and PARALLEL — each worker converts one day's
CSV.gz with its own DuckDB connection, so we use many of the M3 Ultra's cores at once (gz
decompression is single-threaded per file, so file-level parallelism is the win).

Output: silver/<dest>/d=YYYY-MM-DD/data.parquet  (one file per trading day)

Run:
  python -m lake.convert_raw minute --jobs 10
  python -m lake.convert_raw trades --jobs 12          # the multi-hour 2.8 TB job
  python -m lake.convert_raw minute --year 2026        # one year
"""
import os
import glob
import argparse
import duckdb
from concurrent.futures import ProcessPoolExecutor

from .common import SILVER, FLATFILES, TZ

STREAMS = {
    "minute": dict(
        src="minute_aggs_v1", dest="market_bars_minute",
        sel="ticker AS symbol, to_timestamp(window_start/1e9) AS ts_utc, "
            "open, high, low, close, volume, transactions, 'polygon' AS source",
    ),
    "trades": dict(
        src="trades_v1", dest="trades",
        sel="ticker AS symbol, to_timestamp(participant_timestamp/1e9) AS ts_utc, "
            "price, size, exchange, conditions, correction, id, sequence_number, "
            "sip_timestamp, tape, trf_id, trf_timestamp",
    ),
}


def convert_one(task):
    stream, f = task
    cfg = STREAMS[stream]
    date = os.path.basename(f)[:-len(".csv.gz")]
    outdir = f"{SILVER}/{cfg['dest']}/d={date}"
    outfile = f"{outdir}/data.parquet"
    if os.path.exists(outfile):
        return (date, "skip", 0)
    os.makedirs(outdir, exist_ok=True)
    tmp = outfile + ".tmp"
    con = duckdb.connect()
    con.execute(f"SET TimeZone='{TZ}'")
    con.execute(
        f"COPY (SELECT {cfg['sel']} FROM read_csv('{f}', header=true, union_by_name=true)) "
        f"TO '{tmp}' (FORMAT PARQUET, COMPRESSION ZSTD)"
    )
    os.replace(tmp, outfile)                      # atomic: only a complete file is final
    n = con.execute(f"SELECT count(*) FROM read_parquet('{outfile}')").fetchone()[0]
    return (date, "ok", n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stream", choices=list(STREAMS))
    ap.add_argument("--year", default="*")
    ap.add_argument("--jobs", type=int, default=10)
    args = ap.parse_args()

    cfg = STREAMS[args.stream]
    files = sorted(glob.glob(f"{FLATFILES}/{cfg['src']}/{args.year}/*/*.csv.gz"))
    os.makedirs(f"{SILVER}/{cfg['dest']}", exist_ok=True)
    print(f"{args.stream}: {len(files)} day-files  jobs={args.jobs}  → {SILVER}/{cfg['dest']}", flush=True)

    ok = skip = rows = 0
    done = 0
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        for date, st, n in ex.map(convert_one, [(args.stream, f) for f in files]):
            done += 1
            if st == "ok":
                ok += 1; rows += n
            else:
                skip += 1
            if done % 50 == 0 or done == len(files):
                print(f"  {done}/{len(files)}  ok={ok} skip={skip} rows={rows:,}", flush=True)
    print(f"DONE {args.stream}: ok={ok} skip={skip} rows={rows:,}", flush=True)


if __name__ == "__main__":
    main()
