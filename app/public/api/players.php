<?php
// Returns every player with their cumulative points per gameweek, read from the local CSVs.

declare(strict_types=1);

header('Content-Type: application/json');

$season = basename(getenv('SEASON') ?: '2026-2027');
$dir = "/data/$season";

function readCsv(string $path): Generator
{
    $fh = fopen($path, 'r');
    if ($fh === false) {
        http_response_code(500);
        echo json_encode(['error' => 'Could not read ' . basename($path)]);
        exit;
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
    $teams[$t['code']] = $t['short_name'];
}

$players = [];
foreach (readCsv("$dir/players.csv") as $p) {
    $players[(int) $p['player_id']] = [
        'id'     => (int) $p['player_id'],
        'name'   => $p['web_name'],
        'team'   => $teams[$p['team_code']] ?? '',
        'pos'    => $p['position'],
        'cost'   => null,
        'points' => [],
    ];
}

// total_points, minutes, goals etc. in playerstats are running season totals per gameweek.
// Rows aren't in gameweek order, so keep the newest row per player for the "right now" stats.
$maxGw = 0;
$latest = [];
foreach (readCsv("$dir/playerstats.csv") as $s) {
    $id = (int) $s['id'];
    $gw = (int) $s['gw'];
    if (!isset($players[$id]) || $gw < 1) {
        continue;
    }
    $players[$id]['points'][$gw] = (int) $s['total_points'];
    if ($gw >= (int) ($latest[$id]['gw'] ?? 0)) {
        $latest[$id] = $s;
    }
    $maxGw = max($maxGw, $gw);
}

foreach ($latest as $id => $s) {
    $players[$id] += [
        'status'   => $s['status'],                 // a = available, d = doubtful, i = injured, s = suspended, u = unavailable
        'news'     => $s['news'],
        'chance'   => $s['chance_of_playing_next_round'] === '' ? null : (int) $s['chance_of_playing_next_round'],
        'own'      => (float) $s['selected_by_percent'],
        'predNext' => (float) $s['ep_next'],        // FPL's own predicted points for the next gameweek
        'minutes'  => (int) $s['minutes'],
        'starts'   => (int) $s['starts'],
        'goals'    => (int) $s['goals_scored'],
        'assists'  => (int) $s['assists'],
        'xgi'      => (float) $s['expected_goal_involvements'],
        'boughtGw' => (int) $s['transfers_in_event'],
    ];
    $players[$id]['cost'] = (float) $s['now_cost'];
}

// Turn points into a plain array (index 0 = GW1), carrying the total forward over any missing weeks.
foreach ($players as &$p) {
    $series = [];
    $last = 0;
    for ($gw = 1; $gw <= $maxGw; $gw++) {
        $last = $p['points'][$gw] ?? $last;
        $series[] = $last;
    }
    $p['points'] = $series;
}
unset($p);

$list = array_values($players);
usort($list, fn ($a, $b) => end($b['points']) <=> end($a['points']));

echo json_encode(['season' => str_replace('-20', '/', $season), 'gameweeks' => $maxGw, 'players' => $list]);
