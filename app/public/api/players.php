<?php
// Returns every player with their cumulative points per gameweek, read from the local CSVs.

declare(strict_types=1);

header('Content-Type: application/json');

$dir = '/data/' . basename(getenv('SEASON') ?: '2026-2027');

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

// total_points in playerstats is already a running season total per gameweek.
$maxGw = 0;
foreach (readCsv("$dir/playerstats.csv") as $s) {
    $id = (int) $s['id'];
    $gw = (int) $s['gw'];
    if (!isset($players[$id]) || $gw < 1) {
        continue;
    }
    $players[$id]['points'][$gw] = (int) $s['total_points'];
    $players[$id]['cost'] = (float) $s['now_cost'];
    $maxGw = max($maxGw, $gw);
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

echo json_encode(['gameweeks' => $maxGw, 'players' => $list]);
