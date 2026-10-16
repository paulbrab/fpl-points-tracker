"""
Backtest the points projections used by the chip planner.

Replays a past season week by week. Before each gameweek it uses only what was known at the time
(points so far, form, injury status, and fixture ratings from earlier matches) to project every
regular player's points, then compares with what they actually scored.

Usage:  python3 tools/backtest_projections.py FPL-Elo-Insights/data
"""
import csv
import math
import os
import random
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import backtest_fixtures as fx  # noqa: E402  (fixture model, same maths as the app)

fx.BASE = sys.argv[1] if len(sys.argv) > 1 else 'FPL-Elo-Insights/data'
SEASON, LAST = '2025-2026', '2024-2025'
FORM_WEEKS = 5
FIRST_GW = 6            # need a few weeks of history first
REGULAR = 0.5           # "regular" = played at least half the possible minutes so far

# Same as app.js: where each position's points come from [playing & bonus, clean sheets, goals & assists].
POINT_SOURCES = {
    'Goalkeeper': (0.5, 0.5, 0),
    'Defender': (0.4, 0.4, 0.2),
    'Midfielder': (0.4, 0.1, 0.5),
    'Forward': (0.35, 0, 0.65),
}


def load_players():
    base = f'{fx.BASE}/{SEASON}'
    pos = {r['player_id']: r['position'] for r in csv.DictReader(open(f'{base}/players.csv'))}
    team = {(r['player_id'], int(r['gw'])): r['team_code'] for r in csv.DictReader(open(f'{base}/team_history.csv'))}
    snap = {}  # (player, gw) -> snapshot after that gameweek
    for r in csv.DictReader(open(f'{base}/playerstats.csv')):
        snap[(r['id'], int(r['gw']))] = r
    return pos, team, snap


def fixtures_by_gw():
    """gw -> [(home code, away code)] for every PL fixture, played or not."""
    out = defaultdict(list)
    for g in range(1, 39):
        try:
            for r in csv.DictReader(open(f'{fx.BASE}/{SEASON}/By Tournament/Premier League/GW{g}/fixtures.csv')):
                out[int(float(r['gameweek']))].append((str(int(float(r['home_team']))), str(int(float(r['away_team'])))))
        except FileNotFoundError:
            pass
    return out


def num(x, default=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def main():
    pos, team_at, snap = load_players()
    fixtures = fixtures_by_gw()
    played = fx.load(SEASON)
    last = fx.load(LAST)
    teams = {m[1] for m in played} | {m[2] for m in played}
    prior = fx.season_prior(last, teams, True, 0.5)
    players = sorted({p for p, _ in snap})

    # Fixture ratings as known before each gameweek.
    ratings = {}
    for g in range(FIRST_GW, 39):
        past = [m for m in played if m[0] < g]
        avg, boost = fx.league_levels(past + last)
        att, dfn = fx.fit(past, g, teams, prior, 30, None, True, avg, boost)
        ratings[g] = (att, dfn, avg, boost)

    def state(p, g):
        """What we knew about player p just before gameweek g."""
        s = snap.get((p, g - 1))
        if not s:
            return None
        weeks = g - 1
        total = num(s['total_points'])
        earlier = snap.get((p, g - 1 - FORM_WEEKS))
        form = total - (num(earlier['total_points']) if earlier else 0)
        return {
            'rate_season': total / weeks,
            'rate_form': form / min(FORM_WEEKS, weeks),
            'mins_share': num(s['minutes']) / (weeks * 90),
            'status': s['status'],
            'chance': num(s['chance_of_playing_next_round'], 50),
            'team': team_at.get((p, g - 1)),
            'pos': pos.get(p),
            'ep_next': num(s['ep_next']),
        }

    def project(st, decided_gw, target_gw, use_fixtures=True, rate_mix=0.8):
        """Same as projected() in app.js. decided_gw = the gameweek we're planning from."""
        if st['status'] == 'u' or not st['team'] or st['pos'] not in POINT_SOURCES:
            return 0.0
        chance = 1.0
        if st['status'] in ('i', 's') and target_gw < decided_gw + 2:
            chance = 0.0
        if st['status'] == 'd' and target_gw == decided_gw:
            chance = st['chance'] / 100
        rate = rate_mix * st['rate_season'] + (1 - rate_mix) * st['rate_form']
        att, dfn, avg, boost = ratings[decided_gw]
        base, clean, attack = POINT_SOURCES[st['pos']]
        total = 0.0
        for h, a in fixtures.get(target_gw, []):
            if st['team'] not in (h, a):
                continue
            home = st['team'] == h
            opp = a if home else h
            b = boost if home else 1 / boost
            xg_for = avg * att[st['team']] * dfn[opp] * b
            xg_against = avg * att[opp] * dfn[st['team']] / b
            total += base + clean * math.exp(avg - xg_against) + attack * (xg_for / avg) if use_fixtures else 1.0
        return chance * rate * total

    def actual(p, g):
        s = snap.get((p, g))
        return num(s['event_points']) if s else None

    def score(pairs):
        n = len(pairs)
        err = math.sqrt(sum((x - y) ** 2 for x, y in pairs) / n)
        mx, my = sum(x for x, _ in pairs) / n, sum(y for _, y in pairs) / n
        cov = sum((x - mx) * (y - my) for x, y in pairs)
        sx = math.sqrt(sum((x - mx) ** 2 for x, _ in pairs))
        sy = math.sqrt(sum((y - my) ** 2 for _, y in pairs))
        return err, cov / (sx * sy), n

    # 1 & 2: accuracy one week ahead and four weeks ahead, for regular players.
    models = {
        'FPL\'s own prediction (next week only)': None,
        'Usual points rate, ignoring fixtures': dict(use_fixtures=False),
        'Recent form only, with fixtures': dict(rate_mix=0.0),
        'Half season / half form, with fixtures': dict(rate_mix=0.5),
        'Season average only, with fixtures': dict(rate_mix=1.0),
        'App: 80% season / 20% form, with fixtures': dict(),
    }
    print(f'Season replayed: {SEASON} (GW{FIRST_GW}-38), regular players only (played half the minutes so far)\n')
    print(f"{'model':46} {'next week':>22} {'4 weeks ahead':>22}")
    print(f"{'':46} {'error':>8} {'correlation':>12}   {'error':>8} {'correlation':>12}")
    results = {}
    for name, opts in models.items():
        cols = []
        for ahead in (0, 3):
            pairs = []
            for g in range(FIRST_GW, 39 - ahead):
                for p in players:
                    st = state(p, g)
                    if not st or st['mins_share'] < REGULAR:
                        continue
                    a = actual(p, g + ahead)
                    if a is None:
                        continue
                    if opts is None:
                        if ahead:
                            continue
                        pairs.append((st['ep_next'], a))
                    else:
                        pairs.append((project(st, g, g + ahead, **opts), a))
            cols.append(score(pairs) if pairs else None)
        line = f'{name:46}'
        for c in cols:
            line += f' {c[0]:8.2f} {c[1]:12.2f}  ' if c else f" {'-':>8} {'-':>12}  "
        print(line)
        results[name] = cols[0]

    # 3: does the planner's best week really score more? (what Triple Captain relies on)
    # Only normal single-game weeks count, so blank and double gameweeks can't flatter the result.
    window = 10
    gains, spreads = [], []
    for start in range(FIRST_GW, 39 - window + 1):
        weeks = list(range(start, start + window))
        candidates = []
        for p in players:
            st = state(p, start)
            if st and st['mins_share'] >= REGULAR and st['status'] == 'a':
                candidates.append((project(st, start, start, use_fixtures=False), p, st))
        for _, p, st in sorted(candidates, reverse=True)[:20]:  # the kind of player you'd captain
            single = [g for g in weeks if sum(st['team'] in f for f in fixtures.get(g, [])) == 1]
            acts = {g: actual(p, g) for g in single}
            if len(single) < 5 or any(v is None for v in acts.values()):
                continue
            best = max(single, key=lambda g: project(st, start, g))
            worst = min(single, key=lambda g: project(st, start, g))
            gains.append(acts[best] - sum(acts.values()) / len(single))
            spreads.append(acts[best] - acts[worst])
    random.seed(1)
    boots = sorted(sum(random.choices(gains, k=len(gains))) / len(gains) for _ in range(2000))
    print(f'\nBest-week test: for the top 20 players each week, the planner picked their best of the next {window} weeks')
    print('(normal single-game weeks only).')
    print(f'  Picked week vs an average week: {sum(gains) / len(gains):+.2f} pts '
          f'(90% range {boots[100]:+.2f} to {boots[1900]:+.2f}, {len(gains)} picks)')
    print(f'  Picked (easiest) week vs hardest week: {sum(spreads) / len(spreads):+.2f} pts')

    # Guards for automated checks: last season's data never changes, so these only fail if the maths breaks.
    app, fpl = results['App: 80% season / 20% form, with fixtures'], results["FPL's own prediction (next week only)"]
    problems = []
    if not (app[0] < fpl[0] and app[1] > fpl[1]):
        problems.append("projections no longer beat FPL's own prediction")
    if boots[100] <= 0:
        problems.append("the planner's best week is no longer clearly better than an average week")
    if problems:
        print('\nFAIL: ' + '; '.join(problems) + f' ({SEASON}).')
        sys.exit(1)
    print(f'\nOK: projections beat FPL\'s own prediction and the best-week pick helps ({SEASON}).')

if __name__ == '__main__':
    main()
