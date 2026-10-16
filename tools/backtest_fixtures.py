"""
Backtest the fixture-difficulty model.

Replays a past season week by week. Before each gameweek, every model rates the teams using only
matches already played (plus last season as a starting point), then predicts each team's xG in that
gameweek's matches. Score = root mean squared error against the real xG (lower is better).

Usage:  python3 tools/backtest_fixtures.py FPL-Elo-Insights/data
"""
import csv
import itertools
import math
import random
import sys

BASE = sys.argv[1] if len(sys.argv) > 1 else 'FPL-Elo-Insights/data'


def load(season):
    """Finished Premier League matches as (gw, home code, away code, home xG, away xG)."""
    if season == '2024-2025':  # older layout: one file for the season
        paths = [f'{BASE}/{season}/matches/matches.csv']
    else:
        paths = [f'{BASE}/{season}/By Tournament/Premier League/GW{g}/fixtures.csv' for g in range(1, 39)]
    out = []
    for path in paths:
        try:
            for r in csv.DictReader(open(path)):
                if r['finished'].lower() == 'true' and r['home_expected_goals_xg']:
                    out.append((int(float(r['gameweek'])), str(int(float(r['home_team']))), str(int(float(r['away_team']))),
                                float(r['home_expected_goals_xg']), float(r['away_expected_goals_xg'])))
        except FileNotFoundError:
            pass
    return out


def league_levels(ms):
    home = sum(m[3] for m in ms) / len(ms)
    away = sum(m[4] for m in ms) / len(ms)
    return (home + away) / 2, math.sqrt(home / away)


def fit(ms, now_gw, teams, prior, k, half_life, adjusted, avg, boost, rounds=30):
    """Attack (higher = better) and defence (higher = leakier) ratings, 1.0 = average.
    Same maths as app/public/api/fixtures.php when adjusted=True and half_life=None."""
    att = {t: prior[t][0] for t in teams}
    dfn = {t: prior[t][1] for t in teams}
    weight = (lambda gw: 1.0) if not half_life else (lambda gw: 0.5 ** ((now_gw - gw) / half_life))
    for _ in range(rounds if adjusted else 1):
        num_a = {t: k * avg * prior[t][0] for t in teams}
        num_d = {t: k * avg * prior[t][1] for t in teams}
        den_a = {t: k * avg for t in teams}
        den_d = {t: k * avg for t in teams}
        for gw, h, a, hx, ax in ms:
            w = weight(gw)
            dh, da, ah, aa = (dfn[h], dfn[a], att[h], att[a]) if adjusted else (1, 1, 1, 1)
            num_a[h] += w * hx; den_a[h] += w * avg * da * boost
            num_a[a] += w * ax; den_a[a] += w * avg * dh / boost
            num_d[h] += w * ax; den_d[h] += w * avg * aa / boost
            num_d[a] += w * hx; den_d[a] += w * avg * ah * boost
        att = {t: num_a[t] / den_a[t] if den_a[t] else 1 for t in teams}
        dfn = {t: num_d[t] / den_d[t] if den_d[t] else 1 for t in teams}
        if adjusted:
            ma, md = sum(att.values()) / len(att), sum(dfn.values()) / len(dfn)
            att = {t: v / ma for t, v in att.items()}
            dfn = {t: v / md for t, v in dfn.items()}
    return att, dfn


def season_prior(last_ms, teams, adjusted, shrink):
    """Last season's ratings, pulled towards average; promoted teams = last season's 3 weakest."""
    avg, boost = league_levels(last_ms)
    last_teams = {m[1] for m in last_ms} | {m[2] for m in last_ms}
    att, dfn = fit(last_ms, 38, last_teams, {t: (1, 1) for t in last_teams}, 0, None, adjusted, avg, boost)
    weakest = sorted(last_teams, key=lambda t: att[t] - dfn[t])[:3]
    promoted = (sum(att[t] for t in weakest) / 3, sum(dfn[t] for t in weakest) / 3)
    prior = {}
    for t in teams:
        a, d = (att[t], dfn[t]) if t in last_teams else promoted
        prior[t] = (1 + (a - 1) * shrink, 1 + (d - 1) * shrink)
    return prior


def squared_errors(season, last, cfg):
    ms, last_ms = load(season), load(last)
    teams = {m[1] for m in ms} | {m[2] for m in ms}
    prior = season_prior(last_ms, teams, cfg['adjusted'], cfg['shrink']) if cfg['k'] else {t: (1, 1) for t in teams}
    errors = []
    for g in sorted({m[0] for m in ms}):
        if g < 2:
            continue
        past = [m for m in ms if m[0] < g]
        avg, boost = league_levels(past + last_ms)
        if cfg.get('baseline'):
            att = dfn = {t: 1 for t in teams}
        else:
            att, dfn = fit(past, g, teams, prior, cfg['k'], cfg['half_life'], cfg['adjusted'], avg, boost)
        for _, h, a, hx, ax in (m for m in ms if m[0] == g):
            errors.append((avg * att[h] * dfn[a] * boost - hx) ** 2)
            errors.append((avg * att[a] * dfn[h] / boost - ax) ** 2)
    return errors


def rmse(errors):
    return math.sqrt(sum(errors) / len(errors))


SEASONS = [('2025-2026', '2024-2025'), ('2026-2027', '2025-2026')]
BASELINE = dict(name='Baseline: every team average', baseline=True, k=0, half_life=None, adjusted=False, shrink=1)
OLD = dict(name='Old: unadjusted, prior 10 games, no shrink', k=10, half_life=None, adjusted=False, shrink=1)
CHOSEN = dict(name='Chosen: adjusted, prior 30 games, shrink 0.5', k=30, half_life=None, adjusted=True, shrink=0.5)

configs = [BASELINE, OLD, CHOSEN]
for adjusted, k, half_life, shrink in itertools.product([False, True], [0, 10, 20, 30, 40], [None, 8, 20], [0.5, 0.75, 1]):
    if k == 0 and shrink != 1:
        continue
    configs.append(dict(name=f"{'adjusted' if adjusted else 'unadjusted'}, prior {k} games, shrink {shrink}, half-life {half_life or 'none'}",
                        k=k, half_life=half_life, adjusted=adjusted, shrink=shrink))

print('Average error in predicted xG per team per match (lower is better)\n')
print(f"{'model':58} {'2025/26':>8} {'2026/27 so far':>15}")
scored = [(rmse(squared_errors(*SEASONS[0], c)), rmse(squared_errors(*SEASONS[1], c)), c['name']) for c in configs]
for row in scored[:3] + sorted(scored[3:])[:10]:
    print(f'{row[2]:58} {row[0]:8.4f} {row[1]:15.4f}')

print('\nIs the chosen model really better than the old one? (paired bootstrap over matches)')
random.seed(1)
for season, last in SEASONS:
    old, new = squared_errors(season, last, OLD), squared_errors(season, last, CHOSEN)
    per_match = [(old[i] + old[i + 1]) - (new[i] + new[i + 1]) for i in range(0, len(old), 2)]
    boots = [sum(random.choices(per_match, k=len(per_match))) for _ in range(5000)]
    print(f'  {season}: better in {sum(b > 0 for b in boots) / len(boots):.0%} of resamples ({len(per_match)} matches)')
