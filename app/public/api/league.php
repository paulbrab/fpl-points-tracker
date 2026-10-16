<?php
// A mini league's standings plus every manager's picks for one gameweek.
// Picks are fetched in parallel and cached for a few minutes to go easy on the FPL site.

declare(strict_types=1);

header('Content-Type: application/json');

const BASE = 'https://fantasy.premierleague.com/api';
const CACHE_DIR = __DIR__ . '/../../storage/cache';
const CACHE_SECONDS = 600;
const MAX_MANAGERS = 50;   // first page of standings only

function fail(int $code, string $msg): never
{
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

// Fetch several FPL URLs at once. Returns decoded JSON (or null) per key.
function fetchAll(array $urls): array
{
    $multi = curl_multi_init();
    $handles = [];
    foreach ($urls as $key => $url) {
        $h = curl_init($url);
        curl_setopt_array($h, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 15,
            CURLOPT_USERAGENT      => 'Mozilla/5.0 (fpl-viewer)',
        ]);
        curl_multi_add_handle($multi, $h);
        $handles[$key] = $h;
    }
    do {
        $status = curl_multi_exec($multi, $running);
        if ($running) {
            curl_multi_select($multi);
        }
    } while ($running && $status === CURLM_OK);

    $out = [];
    foreach ($handles as $key => $h) {
        $ok = curl_getinfo($h, CURLINFO_HTTP_CODE) === 200;
        $out[$key] = $ok ? json_decode((string) curl_multi_getcontent($h), true) : null;
        curl_multi_remove_handle($multi, $h);
    }
    curl_multi_close($multi);
    return $out;
}

$id = filter_input(INPUT_GET, 'id', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
$gw = filter_input(INPUT_GET, 'gw', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 38]]);
if (!$id || !$gw) {
    fail(400, 'Missing league or gameweek.');
}

$cacheFile = CACHE_DIR . "/league-$id-$gw.json";
if (is_file($cacheFile) && time() - filemtime($cacheFile) < CACHE_SECONDS) {
    readfile($cacheFile);
    exit;
}

$standings = fetchAll(['s' => BASE . "/leagues-classic/$id/standings/"])['s'];
if (!$standings) {
    fail(404, 'League not found.');
}

$results = array_slice($standings['standings']['results'] ?? [], 0, MAX_MANAGERS);
$urls = [];
foreach ($results as $r) {
    $urls[$r['entry']] = BASE . "/entry/{$r['entry']}/event/$gw/picks/";
}
$allPicks = fetchAll($urls);

$managers = [];
foreach ($results as $r) {
    $p = $allPicks[$r['entry']] ?? null;
    $managers[] = [
        'entry'    => (int) $r['entry'],
        'team'     => $r['entry_name'],
        'player'   => $r['player_name'],
        'rank'     => (int) $r['rank'],
        'lastRank' => (int) ($r['last_rank'] ?? 0),
        'total'    => (int) $r['total'],
        'gwPoints' => (int) $r['event_total'],
        'chip'     => $p['active_chip'] ?? null,
        'picks'    => array_map(fn ($x) => [
            'id'         => (int) $x['element'],
            'multiplier' => (int) $x['multiplier'],
        ], $p['picks'] ?? []),
    ];
}

$json = json_encode([
    'name'     => $standings['league']['name'] ?? "League $id",
    'gw'       => $gw,
    'size'     => count($standings['standings']['results'] ?? []),
    'more'     => (bool) ($standings['standings']['has_next'] ?? false),
    'managers' => $managers,
]);

if (is_dir(CACHE_DIR) || @mkdir(CACHE_DIR, 0775, true)) {
    file_put_contents($cacheFile, $json, LOCK_EX);
}
echo $json;
