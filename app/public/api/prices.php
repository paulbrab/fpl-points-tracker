<?php
// Live transfer numbers for every player, for the price change watch.
// FPL changes prices overnight based on how many managers buy or sell a player; the exact rule is secret.
// Cached for 30 minutes: the numbers move through the day, but not minute by minute.

declare(strict_types=1);

header('Content-Type: application/json');

const CACHE_FILE = __DIR__ . '/../../storage/cache/prices.json';
const CACHE_SECONDS = 1800;

if (is_file(CACHE_FILE) && time() - filemtime(CACHE_FILE) < CACHE_SECONDS) {
    readfile(CACHE_FILE);
    exit;
}

$ctx = stream_context_create(['http' => [
    'timeout'       => 15,
    'ignore_errors' => true,
    'header'        => "User-Agent: Mozilla/5.0 (fpl-viewer)\r\n",
]]);
$body = @file_get_contents('https://fantasy.premierleague.com/api/bootstrap-static/', false, $ctx);
$boot = $body ? json_decode($body, true) : null;
if (empty($boot['elements'])) {
    http_response_code(502);
    echo json_encode(['error' => 'Could not reach the FPL website.']);
    exit;
}

$players = [];
foreach ($boot['elements'] as $e) {
    $players[$e['id']] = [
        'in'           => (int) $e['transfers_in_event'],   // this gameweek so far
        'out'          => (int) $e['transfers_out_event'],
        'own'          => (float) $e['selected_by_percent'],
        'cost'         => $e['now_cost'] / 10,
        'changeThisGw' => $e['cost_change_event'] / 10,     // price change since the last deadline
    ];
}

$json = json_encode([
    'updated'      => gmdate('c'),
    'totalManagers' => (int) ($boot['total_players'] ?? 0),
    'players'      => $players,
]);
if (is_dir(dirname(CACHE_FILE)) || @mkdir(dirname(CACHE_FILE), 0775, true)) {
    file_put_contents(CACHE_FILE, $json, LOCK_EX);
}
echo $json;
