<?php
// Next few fixtures for every team, each with a 1 (easy) to 5 (hard) difficulty.
//
// How difficulty works:
//  - Every team gets an attack rating (xG created) and a defence rating (xG conceded), 1.0 = average.
//  - Ratings are opponent-adjusted: all teams are fitted together, so xG against a weak defence
//    counts for less than xG against a strong one.
//  - Teams start from last season's ratings, pulled PRIOR_SHRINK of the way back to average (squads
//    change over the summer) and counted as if they'd already played PRIOR_GAMES games. This season's
//    matches then gradually take over. Promoted teams start like last season's three weakest sides.
//  - These settings were chosen by backtesting: replaying 2025/26 week by week and predicting each
//    match's xG from earlier games only (see README). Weighting recent games more did not help.
//  - Difficulty is about the OPPONENT only (like FPL's own ratings):
//      attackers ('att') -> how good the opponent's defence is,
//      defenders and keepers ('def') -> how good the opponent's attack is,
//    with home advantage taken into account.
//  - Ratings are split into fifths across all upcoming fixtures: 1 = easiest fifth, 5 = hardest fifth.

declare(strict_types=1);

header('Content-Type: application/json');

const WEEKS_AHEAD = 5;     // weeks used for the 1-5 colour bands (and the default to return)
const PRIOR_GAMES = 30;    // how much last season counts, in games
const PRIOR_SHRINK = 0.5;  // how much of last season's difference from average carries over
const FIT_ROUNDS = 30;     // rounds of fitting; ratings settle well before this

$season = basename(getenv('SEASON') ?: '2026-2027');
[$y1, $y2] = array_map('intval', explode('-', $season));
$lastSeason = ($y1 - 1) . '-' . ($y2 - 1);

function readCsv(string $path): Generator
{
    $fh = @fopen($path, 'r');
    if ($fh === false) {
        return;
    }
    $head = fgetcsv($fh, escape: '');
    while (($row = fgetcsv($fh, escape: '')) !== false) {
        if (count($row) === count($head)) {
            yield array_combine($head, $row);
        }
    }
    fclose($fh);
}

// Finished matches as [home code, away code, home xG, away xG], plus (optionally) unplayed fixtures.
function seasonFixtures(string $season, ?array &$upcoming = null): array
{
    $played = [];
    for ($gw = 1; $gw <= 38; $gw++) {
        foreach (readCsv("/data/$season/By Tournament/Premier League/GW$gw/fixtures.csv") as $f) {
            $home = (string) (int) (float) $f['home_team'];
            $away = (string) (int) (float) $f['away_team'];
            if ($f['finished'] === 'True' && $f['home_expected_goals_xg'] !== '') {
                $played[] = [$home, $away, (float) $f['home_expected_goals_xg'], (float) $f['away_expected_goals_xg']];
            } elseif ($f['finished'] !== 'True' && $upcoming !== null) {
                $upcoming[] = ['gw' => $gw, 'home' => $home, 'away' => $away, 'kickoff' => $f['kickoff_time']];
            }
        }
    }
    return $played;
}

// League scoring level and home advantage.
function leagueLevels(array $played): array
{
    $homeXg = array_sum(array_column($played, 2)) / count($played);
    $awayXg = array_sum(array_column($played, 3)) / count($played);
    return [($homeXg + $awayXg) / 2, sqrt($homeXg / $awayXg)];
}

// Opponent-adjusted attack and defence ratings (1.0 = average).
// Model: a team's expected xG = league average x its attack x opponent's defence x home advantage.
// Each round re-estimates every team given the others' current ratings. $prior gives each team
// a head start worth $priorGames games against an average opponent.
function rateTeams(array $played, float $avg, float $homeBoost, array $prior, int $priorGames): array
{
    $teams = array_keys($prior);
    foreach ($played as [$h, $a]) {
        $teams[] = $h;
        $teams[] = $a;
    }
    $teams = array_unique($teams);
    $att = $def = [];
    foreach ($teams as $t) {
        $att[$t] = $prior[$t]['attack'] ?? 1.0;
        $def[$t] = $prior[$t]['defence'] ?? 1.0;
    }

    for ($round = 0; $round < FIT_ROUNDS; $round++) {
        $num = $den = [];
        foreach ($teams as $t) {
            // Head start: $priorGames games against an average opponent at the prior rating.
            // $num = xG actually [scored, conceded]; $den = xG an average team would have [scored, conceded].
            $num[$t] = [$priorGames * $avg * ($prior[$t]['attack'] ?? 1.0), $priorGames * $avg * ($prior[$t]['defence'] ?? 1.0)];
            $den[$t] = [$priorGames * $avg, $priorGames * $avg];
        }
        foreach ($played as [$h, $a, $hx, $ax]) {
            $num[$h][0] += $hx;
            $den[$h][0] += $avg * $def[$a] * $homeBoost;
            $num[$a][0] += $ax;
            $den[$a][0] += $avg * $def[$h] / $homeBoost;
            $num[$h][1] += $ax;
            $den[$h][1] += $avg * $att[$a] / $homeBoost;
            $num[$a][1] += $hx;
            $den[$a][1] += $avg * $att[$h] * $homeBoost;
        }
        foreach ($teams as $t) {
            $att[$t] = $den[$t][0] > 0 ? $num[$t][0] / $den[$t][0] : 1.0;
            $def[$t] = $den[$t][1] > 0 ? $num[$t][1] / $den[$t][1] : 1.0;
        }
        // Keep the average team at exactly 1.0.
        $meanAtt = array_sum($att) / count($att);
        $meanDef = array_sum($def) / count($def);
        foreach ($teams as $t) {
            $att[$t] /= $meanAtt;
            $def[$t] /= $meanDef;
        }
    }

    $ratings = [];
    foreach ($teams as $t) {
        $ratings[$t] = ['attack' => $att[$t], 'defence' => $def[$t]];
    }
    return $ratings;
}

$teams = [];
foreach (readCsv("/data/$season/teams.csv") as $t) {
    $teams[$t['code']] = ['short' => $t['short_name'], 'name' => $t['name']];
}

$upcoming = [];
$played = seasonFixtures($season, $upcoming);
$upcoming = array_values(array_filter($upcoming, fn ($f) => isset($teams[$f['home']], $teams[$f['away']])));
if (!$upcoming) {
    echo json_encode(['nextGw' => null, 'teams' => new stdClass()]);
    exit;
}

// Starting point: last season, pulled part of the way back to average.
// Promoted teams start like last season's three weakest sides.
$lastPlayed = seasonFixtures($lastSeason);
$prior = [];
foreach ($teams as $code => $_) {
    $prior[$code] = ['attack' => 1.0, 'defence' => 1.0];
}
if ($lastPlayed) {
    [$lastAvg, $lastBoost] = leagueLevels($lastPlayed);
    $last = rateTeams($lastPlayed, $lastAvg, $lastBoost, [], 0);
    uasort($last, fn ($a, $b) => ($a['attack'] - $a['defence']) <=> ($b['attack'] - $b['defence']));
    $weakest = array_slice($last, 0, 3);
    $promoted = [
        'attack'  => array_sum(array_column($weakest, 'attack')) / 3,
        'defence' => array_sum(array_column($weakest, 'defence')) / 3,
    ];
    foreach ($teams as $code => $_) {
        $r = $last[$code] ?? $promoted;
        $prior[$code] = [
            'attack'  => 1 + ($r['attack'] - 1) * PRIOR_SHRINK,
            'defence' => 1 + ($r['defence'] - 1) * PRIOR_SHRINK,
        ];
    }
}

if (!$played && !$lastPlayed) {
    echo json_encode(['nextGw' => null, 'teams' => new stdClass()]);
    exit;
}

// Scoring level and home advantage from both seasons (steadier early on), then this season's matches
// on top of the starting point.
[$avg, $homeBoost] = leagueLevels(array_merge($lastPlayed, $played));
$rating = $played ? rateTeams($played, $avg, $homeBoost, $prior, PRIOR_GAMES) : $prior;

// Only the next few gameweeks.
// ?weeks=N returns more gameweeks (e.g. for chip planning); colour bands still use the next WEEKS_AHEAD.
$weeks = filter_input(INPUT_GET, 'weeks', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 38]]) ?: WEEKS_AHEAD;
$nextGw = min(array_column($upcoming, 'gw'));
$upcoming = array_filter($upcoming, fn ($f) => $f['gw'] < $nextGw + $weeks);
usort($upcoming, fn ($a, $b) => [$a['gw'], $a['kickoff']] <=> [$b['gw'], $b['kickoff']]);

// From each team's point of view: how tough is the opponent, and how many goals do we expect each way?
$rows = [];
foreach ($upcoming as $f) {
    foreach ([[$f['home'], $f['away'], true], [$f['away'], $f['home'], false]] as [$team, $opp, $isHome]) {
        $boost = $isHome ? $homeBoost : 1 / $homeBoost;
        $rows[] = [
            'team'      => $team,
            'gw'        => $f['gw'],
            'opp'       => $teams[$opp]['short'],
            'oppName'   => $teams[$opp]['name'],
            'home'      => $isHome,
            // Higher = easier for our attackers (leaky opponent defence, home game).
            'attEase'   => $rating[$opp]['defence'] * $boost,
            // Higher = harder for our defenders (dangerous opponent attack, away game).
            'defThreat' => $rating[$opp]['attack'] / $boost,
            'xgFor'     => $avg * $rating[$team]['attack'] * $rating[$opp]['defence'] * $boost,
            'xgAgainst' => $avg * $rating[$opp]['attack'] * $rating[$team]['defence'] / $boost,
        ];
    }
}

// Split into fifths across all upcoming fixtures.
function cuts(array $values): array
{
    sort($values);
    $n = count($values);
    return array_map(fn ($i) => $values[(int) floor($n * $i / 5)], [1, 2, 3, 4]);
}
function band(float $v, array $cuts): int
{
    $b = 1;
    foreach ($cuts as $c) {
        if ($v >= $c) {
            $b++;
        }
    }
    return $b;
}
$soon = array_filter($rows, fn ($r) => $r['gw'] < $nextGw + WEEKS_AHEAD);
$attCuts = cuts(array_map(fn ($r) => -$r['attEase'], $soon));
$defCuts = cuts(array_column($soon, 'defThreat'));

$out = [];
foreach ($rows as $r) {
    $out[$teams[$r['team']]['short']][] = [
        'gw'        => $r['gw'],
        'opp'       => $r['opp'],
        'oppName'   => $r['oppName'],
        'home'      => $r['home'],
        'att'       => band(-$r['attEase'], $attCuts),
        'def'       => band($r['defThreat'], $defCuts),
        'xgFor'     => round($r['xgFor'], 2),
        'xgAgainst' => round($r['xgAgainst'], 2),
    ];
}

echo json_encode(['nextGw' => $nextGw, 'weeks' => $weeks, 'avgXg' => round($avg, 3), 'teams' => $out]);
