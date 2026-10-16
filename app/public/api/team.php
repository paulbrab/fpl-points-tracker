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

echo json_encode([
    'name'  => $entry['name'] ?? "Team $id",
    'gw'    => $gw,
    'bank'  => ($history['bank'] ?? 0) / 10,        // FPL stores money in tenths of a million
    'value' => ($history['value'] ?? 0) / 10,
    'gwPoints'    => $history['points'] ?? null,
    'totalPoints' => $entry['summary_overall_points'] ?? null,
    'rank'        => $entry['summary_overall_rank'] ?? null,
    'picks' => array_map(fn ($p) => [
        'id'      => (int) $p['element'],
        'captain' => (bool) $p['is_captain'],
        'bench'   => $p['position'] > 11,
    ], $picks['picks'] ?? []),
]);
