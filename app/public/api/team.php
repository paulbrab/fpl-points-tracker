<?php
// Looks up an FPL manager's current picks. The FPL site blocks browser calls, so we fetch it here.

declare(strict_types=1);

header('Content-Type: application/json');

function fail(int $code, string $msg): never
{
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

function fetchJson(string $url): ?array
{
    $ctx = stream_context_create(['http' => [
        'timeout'       => 10,
        'ignore_errors' => true,
        'header'        => "User-Agent: Mozilla/5.0 (fpl-viewer)\r\n",
    ]]);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false || !str_contains($http_response_header[0] ?? '', ' 200')) {
        return null;
    }
    return json_decode($body, true);
}

// This season's chips and the gameweeks each can be played in. Rarely changes, so cached for a day.
function chipRules(string $base): array
{
    $file = __DIR__ . '/../../storage/cache/chip-rules.json';
    if (is_file($file) && time() - filemtime($file) < 86400) {
        return json_decode((string) file_get_contents($file), true) ?: [];
    }
    $rules = array_map(fn ($c) => [
        'name'  => $c['name'],
        'start' => (int) $c['start_event'],
        'stop'  => (int) $c['stop_event'],
    ], fetchJson("$base/bootstrap-static/")['chips'] ?? []);
    if ($rules && (is_dir(dirname($file)) || @mkdir(dirname($file), 0775, true))) {
        file_put_contents($file, json_encode($rules), LOCK_EX);
    }
    return $rules;
}

$id = filter_input(INPUT_GET, 'id', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
if (!$id) {
    fail(400, 'Please enter a valid team ID (numbers only).');
}

$base = 'https://fantasy.premierleague.com/api';

$entry = fetchJson("$base/entry/$id/");
if (!$entry) {
    fail(404, 'Team not found.');
}

$gw = (int) ($entry['current_event'] ?? 0);
$picks = $gw ? fetchJson("$base/entry/$id/event/$gw/picks/") : null;
if (!$picks) {
    fail(404, 'No picks found for this team yet.');
}

$history = $picks['entry_history'] ?? [];
$past = fetchJson("$base/entry/$id/history/") ?? [];

echo json_encode([
    'name'  => $entry['name'] ?? "Team $id",
    'gw'    => $gw,
    'bank'  => ($history['bank'] ?? 0) / 10,        // FPL stores money in tenths of a million
    'value' => ($history['value'] ?? 0) / 10,
    'gwPoints'    => $history['points'] ?? null,
    'totalPoints' => $entry['summary_overall_points'] ?? null,
    'rank'        => $entry['summary_overall_rank'] ?? null,
    // Private classic leagues only (type 'x'); the rest are public ones like "Overall".
    'chipsUsed' => array_map(fn ($c) => ['name' => $c['name'], 'gw' => (int) $c['event']], $past['chips'] ?? []),
    'chipRules' => chipRules($base),
    'leagues' => array_values(array_map(
        fn ($l) => ['id' => (int) $l['id'], 'name' => $l['name'], 'rank' => $l['entry_rank'] ?? null, 'size' => $l['rank_count'] ?? null],
        array_filter($entry['leagues']['classic'] ?? [], fn ($l) => ($l['league_type'] ?? '') === 'x'),
    )),
    'picks' => array_map(fn ($p) => [
        'id'      => (int) $p['element'],
        'captain' => (bool) $p['is_captain'],
        'bench'   => $p['position'] > 11,
        'multiplier' => (int) $p['multiplier'],   // 0 = bench, 1 = playing, 2 = captain, 3 = triple captain
    ], $picks['picks'] ?? []),
]);
