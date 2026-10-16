<?php
// Next few fixtures for every team, each with a 1 (easy) to 5 (hard) difficulty.
//
// How difficulty works:
//  - Every team gets an attack rating (xG created per game) and a defence rating (xG conceded per game).
//  - Teams start from last season's ratings, counted as if they'd already played PRIOR_GAMES games.
//    This season's matches then gradually take over, so one freak result early on doesn't dominate.
//    Promoted teams start like last season's three weakest sides.
//  - Difficulty is about the OPPONENT only (like FPL's own ratings):
//      attackers ('att') -> how good the opponent's defence is,
//      defenders and keepers ('def') -> how good the opponent's attack is,
//    with home advantage taken into account.
//  - Ratings are split into fifths across all upcoming fixtures: 1 = easiest fifth, 5 = hardest fifth.

declare(strict_types=1);

header('Content-Type: application/json');

const WEEKS_AHEAD = 5;
const PRIOR_GAMES = 10;  // how much last season counts, in games

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

// Attack and defence ratings (1.0 = league average). $prior gives each team a head start worth $priorGames games.
function rateTeams(array $played, array $prior = [], int $priorGames = 0): array
{
    $homeXg = array_sum(array_column($played, 2)) / count($played);
    $awayXg = array_sum(array_column($played, 3)) / count($played);
    $avg = ($homeXg + $awayXg) / 2;
    $homeBoost = sqrt($homeXg / $awayXg);

    $sum = [];
    foreach ($prior as $code => $p) {
        $sum[$code] = ['for' => $p['attack'] * $avg * $priorGames, 'against' => $p['defence'] * $avg * $priorGames, 'games' => $priorGames];
    }
    foreach ($played as [$h, $a, $hx, $ax]) {
        foreach ([$h, $a] as $t) {
            $sum[$t] ??= ['for' => 0, 'against' => 0, 'games' => 0];
        }
        // Remove home advantage so home and away games count the same.
        $sum[$h]['for'] += $hx / $homeBoost;
        $sum[$h]['against'] += $ax * $homeBoost;
        $sum[$a]['for'] += $ax * $homeBoost;
        $sum[$a]['against'] += $hx / $homeBoost;
        $sum[$h]['games']++;
        $sum[$a]['games']++;
    }

    $ratings = [];
    foreach ($sum as $code => $s) {
        $ratings[$code] = [
            'attack'  => $s['for'] / $s['games'] / $avg,
            'defence' => $s['against'] / $s['games'] / $avg,
        ];
    }
    return ['ratings' => $ratings, 'avg' => $avg, 'homeBoost' => $homeBoost];
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

// Starting point: last season. Promoted teams start like last season's three weakest sides.
$prior = [];
$lastPlayed = seasonFixtures($lastSeason);
if ($lastPlayed) {
    $last = rateTeams($lastPlayed)['ratings'];
    uasort($last, fn ($a, $b) => ($a['attack'] - $a['defence']) <=> ($b['attack'] - $b['defence']));
    $weakest = array_slice($last, 0, 3);
    $promoted = [
        'attack'  => array_sum(array_column($weakest, 'attack')) / 3,
        'defence' => array_sum(array_column($weakest, 'defence')) / 3,
    ];
    foreach ($teams as $code => $_) {
        $prior[$code] = $last[$code] ?? $promoted;
    }
} else {
    foreach ($teams as $code => $_) {
        $prior[$code] = ['attack' => 1.0, 'defence' => 1.0];
    }
}

// This season's matches on top of the starting point.
if ($played) {
    $model = rateTeams($played, $prior, PRIOR_GAMES);
} elseif ($lastPlayed) {
    // Before a ball is kicked: last season's ratings as they are.
    $model = rateTeams($lastPlayed);
    $model['ratings'] = $prior;
} else {
    echo json_encode(['nextGw' => null, 'teams' => new stdClass()]);
    exit;
}
['ratings' => $rating, 'avg' => $avg, 'homeBoost' => $homeBoost] = $model;

// Only the next few gameweeks.
$nextGw = min(array_column($upcoming, 'gw'));
$upcoming = array_filter($upcoming, fn ($f) => $f['gw'] < $nextGw + WEEKS_AHEAD);
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
$attCuts = cuts(array_map(fn ($r) => -$r['attEase'], $rows));
$defCuts = cuts(array_column($rows, 'defThreat'));

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

echo json_encode(['nextGw' => $nextGw, 'weeks' => WEEKS_AHEAD, 'teams' => $out]);
