<?php
// Next few fixtures for every team, each with a 1 (easy) to 5 (hard) difficulty.
//
// How difficulty works:
//  - Every team gets an attack rating (xG created per game) and a defence rating (xG conceded per game)
//    from this season's finished Premier League matches.
//  - Early in the season these are pulled towards the league average, so a few lucky games don't dominate.
//  - For a fixture we estimate the goals each side should score (attack x opponent's defence, plus home advantage).
//  - Attackers care about goals their team scores; defenders and keepers care about goals conceded,
//    so each fixture gets two ratings: 'att' and 'def'.
//  - Ratings are split into fifths across all upcoming fixtures: 1 = easiest fifth, 5 = hardest fifth.

declare(strict_types=1);

header('Content-Type: application/json');

const WEEKS_AHEAD = 5;
const PRIOR_GAMES = 4;   // how many "average" games every team starts with

$dir = '/data/' . basename(getenv('SEASON') ?: '2026-2027');

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

$teams = [];
foreach (readCsv("$dir/teams.csv") as $t) {
    $teams[$t['code']] = ['short' => $t['short_name'], 'name' => $t['name']];
}

// Gather every Premier League fixture.
$played = [];
$upcoming = [];
for ($gw = 1; $gw <= 38; $gw++) {
    foreach (readCsv("$dir/By Tournament/Premier League/GW$gw/fixtures.csv") as $f) {
        $home = (string) (int) (float) $f['home_team'];
        $away = (string) (int) (float) $f['away_team'];
        if (!isset($teams[$home], $teams[$away])) {
            continue;
        }
        if ($f['finished'] === 'True' && $f['home_expected_goals_xg'] !== '') {
            $played[] = [$home, $away, (float) $f['home_expected_goals_xg'], (float) $f['away_expected_goals_xg']];
        } elseif ($f['finished'] !== 'True') {
            $upcoming[] = ['gw' => $gw, 'home' => $home, 'away' => $away, 'kickoff' => $f['kickoff_time']];
        }
    }
}

if (!$played || !$upcoming) {
    echo json_encode(['nextGw' => null, 'teams' => new stdClass()]);
    exit;
}

// League averages and home advantage.
$homeXg = array_sum(array_column($played, 2)) / count($played);
$awayXg = array_sum(array_column($played, 3)) / count($played);
$avg = ($homeXg + $awayXg) / 2;
$homeBoost = sqrt($homeXg / $awayXg);

// Attack = xG created per game, defence = xG conceded per game (both relative to average, 1.0 = average).
$sum = [];
foreach ($teams as $code => $_) {
    $sum[$code] = ['for' => $avg * PRIOR_GAMES, 'against' => $avg * PRIOR_GAMES, 'games' => PRIOR_GAMES];
}
foreach ($played as [$h, $a, $hx, $ax]) {
    // Remove home advantage so home and away games count the same.
    $sum[$h]['for'] += $hx / $homeBoost;
    $sum[$h]['against'] += $ax * $homeBoost;
    $sum[$a]['for'] += $ax * $homeBoost;
    $sum[$a]['against'] += $hx / $homeBoost;
    $sum[$h]['games']++;
    $sum[$a]['games']++;
}
$rating = [];
foreach ($sum as $code => $s) {
    $rating[$code] = [
        'attack'  => $s['for'] / $s['games'] / $avg,
        'defence' => $s['against'] / $s['games'] / $avg,
    ];
}

// Only the next few gameweeks.
$nextGw = min(array_column($upcoming, 'gw'));
$upcoming = array_filter($upcoming, fn ($f) => $f['gw'] < $nextGw + WEEKS_AHEAD);
usort($upcoming, fn ($a, $b) => [$a['gw'], $a['kickoff']] <=> [$b['gw'], $b['kickoff']]);

// Expected goals for and against, from each team's point of view.
$rows = [];
foreach ($upcoming as $f) {
    foreach ([[$f['home'], $f['away'], true], [$f['away'], $f['home'], false]] as [$team, $opp, $isHome]) {
        $boost = $isHome ? $homeBoost : 1 / $homeBoost;
        $rows[] = [
            'team'   => $team,
            'gw'     => $f['gw'],
            'opp'    => $teams[$opp]['short'],
            'oppName'=> $teams[$opp]['name'],
            'home'   => $isHome,
            'xgFor'  => $avg * $rating[$team]['attack'] * $rating[$opp]['defence'] * $boost,
            'xgAgainst' => $avg * $rating[$opp]['attack'] * $rating[$team]['defence'] / $boost,
        ];
    }
}

// Split into fifths: attackers want high xgFor, defenders want low xgAgainst.
function bands(array $values): array
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
$attCuts = bands(array_map(fn ($r) => -$r['xgFor'], $rows));
$defCuts = bands(array_column($rows, 'xgAgainst'));

$out = [];
foreach ($rows as $r) {
    $out[$teams[$r['team']]['short']][] = [
        'gw'      => $r['gw'],
        'opp'     => $r['opp'],
        'oppName' => $r['oppName'],
        'home'    => $r['home'],
        'att'     => band(-$r['xgFor'], $attCuts),
        'def'     => band($r['xgAgainst'], $defCuts),
        'xgFor'   => round($r['xgFor'], 2),
        'xgAgainst' => round($r['xgAgainst'], 2),
    ];
}

echo json_encode(['nextGw' => $nextGw, 'weeks' => WEEKS_AHEAD, 'teams' => $out]);
