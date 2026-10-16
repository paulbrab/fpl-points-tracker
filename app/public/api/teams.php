<?php
// The household's saved teams (name + FPL ID). GET returns the list, POST replaces it.
// Stored outside the public folder so it can't be downloaded directly.

declare(strict_types=1);

header('Content-Type: application/json');

const FILE = __DIR__ . '/../../storage/teams.json';
const MAX_TEAMS = 20;

function fail(int $code, string $msg): never
{
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo is_file(FILE) ? file_get_contents(FILE) : '[]';
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    fail(405, 'Method not allowed.');
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input) || !array_is_list($input) || count($input) > MAX_TEAMS) {
    fail(400, 'Invalid list of teams.');
}

$teams = [];
foreach ($input as $t) {
    $name = trim((string) ($t['name'] ?? ''));
    $id = filter_var($t['id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 99999999]]);
    if ($name === '' || mb_strlen($name) > 30 || $id === false) {
        fail(400, 'Each team needs a name (up to 30 letters) and a number ID.');
    }
    $teams[] = ['name' => $name, 'id' => $id];
}

if (!is_dir(dirname(FILE)) && !mkdir(dirname(FILE), 0775, true)) {
    fail(500, 'Could not create storage folder.');
}
$json = json_encode($teams, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
if (file_put_contents(FILE, $json, LOCK_EX) === false) {
    fail(500, 'Could not save teams.');
}
echo $json;
