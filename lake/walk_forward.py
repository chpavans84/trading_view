"""Walk-forward logistic regression on the corrected lake — out-of-sample, per-regime.

Trains ONLY on past years, tests on each subsequent year (no leakage, true walk-forward).
Features from gold/features_daily (split-adjusted, survivorship-free). Label: fwd_ret_10d > 0.
Reports per test-year (= regime) AUC + the practical metric: median fwd_ret_10d of the model's
top-decile picks vs bottom-decile. Also prints learned coefficients (which signals it weights).

Run: python -m lake.walk_forward
"""
import duckdb
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score
from .common import GOLD

FEATURES = ['dist_52whigh', 'ret_5d', 'ret_20d', 'ret_60d', 'vol_20d', 'rvol',
            'dist_sma50', 'dist_sma200', 'rs_spy_20']
REGIME = {2020: 'COVID crash', 2021: '2021 bull', 2022: '2022 bear',
          2023: 'AI bull', 2024: 'AI bull', 2025: 'recent', 2026: 'recent'}


def main():
    con = duckdb.connect(); con.execute("SET TimeZone='America/New_York'")
    cols = ", ".join(FEATURES)
    df = con.execute(f"""
        SELECT y, {cols}, fwd_ret_10d
        FROM read_parquet('{GOLD}/features_daily/**/*.parquet')
        WHERE fwd_ret_10d IS NOT NULL
          AND {' AND '.join(f'{f} IS NOT NULL' for f in FEATURES)}
    """).df()
    # clip feature + return outliers (robustness; glitchy adjusted prices)
    for f in FEATURES:
        lo, hi = df[f].quantile([0.01, 0.99]); df[f] = df[f].clip(lo, hi)
    df['label'] = (df['fwd_ret_10d'] > 0).astype(int)
    print(f"rows={len(df):,}  features={len(FEATURES)}  years={sorted(df.y.unique())}")

    print(f"\n{'test year':12s}{'regime':14s}{'n_test':>10s}{'AUC':>8s}{'top10% fwd':>12s}{'bot10% fwd':>12s}{'spread':>9s}")
    for ty in range(2020, 2027):
        tr = df[(df.y >= 2017) & (df.y < ty)]
        te = df[df.y == ty]
        if len(tr) < 5000 or len(te) < 2000:
            continue
        sc = StandardScaler().fit(tr[FEATURES])
        m = LogisticRegression(max_iter=2000, C=1.0).fit(sc.transform(tr[FEATURES]), tr['label'])
        p = m.predict_proba(sc.transform(te[FEATURES]))[:, 1]
        auc = roc_auc_score(te['label'], p)
        q = np.quantile(p, [0.1, 0.9])
        top = te['fwd_ret_10d'][p >= q[1]].median() * 100
        bot = te['fwd_ret_10d'][p <= q[0]].median() * 100
        print(f"{ty:<12d}{REGIME.get(ty,''):14s}{len(te):>10,d}{auc:>8.3f}{top:>11.2f}%{bot:>11.2f}%{top-bot:>8.2f}pp")

    # Coefficients from a full-history model (sign = direction the model trusts)
    sc = StandardScaler().fit(df[FEATURES])
    m = LogisticRegression(max_iter=2000).fit(sc.transform(df[FEATURES]), df['label'])
    print("\nlearned weights (standardized; + = bullish signal, - = bearish):")
    for f, c in sorted(zip(FEATURES, m.coef_[0]), key=lambda x: -abs(x[1])):
        print(f"  {f:14s}{c:+.3f}")


if __name__ == "__main__":
    main()
