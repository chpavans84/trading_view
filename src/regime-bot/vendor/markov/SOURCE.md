# Vendored Source — markov_regime.py

This file is a vendored copy of `scripts/markov_regime.py` from:

- **Upstream repo:** https://github.com/jackson-video-resources/markov-hedge-fund-method
- **Commit:** fe24cf9426874eeabdb1bcaca2fe9d7666fb0d7c
- **Commit date:** 2026-05-20T12:21:26+01:00
- **Vendored on:** 2026-05-21T10:46:39Z

## Why vendored

Per project rule: "Make our own copy into our repo so we maintain our code base."
This ensures the script can't change underneath us and our backtests stay reproducible.

## Modifications

**None.** The script is used as-is. Our integration relies on its existing
`--csv` flag for DB-backed price input.

## Refresh procedure

To update to a newer upstream version:
1. Re-run `scripts/regime/install.sh` — it will overwrite this directory
2. Review the diff in `markov_regime.py` before committing
3. Update commit hash above
4. Re-run regime-bot backtest to confirm no behavior change for the test basket

## Dependencies (PEP 723 inline)

Resolved automatically by `uv` on first run. The script declares:
```python
# requires-python = ">=3.10"
# dependencies = ["numpy", "pandas", "yfinance", "hmmlearn", "scipy"]
```

## Invocation

```bash
uv run src/regime-bot/vendor/markov/markov_regime.py --csv <path-to-prices.csv> --json
```
