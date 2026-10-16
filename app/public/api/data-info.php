<?php
// Which version of the player data is in use, when it was made, and whether newer data exists.
// Reads the data folder's git files directly (they're plain text, so no git needed), then asks
// GitHub for the dates. Answers are cached so GitHub is asked at most a couple of times an hour.

declare(strict_types=1);

header('Content-Type: application/json');

const DATA_REPO = '/repo/FPL-Elo-Insights';
const API = 'https://api.github.com/repos/olbauday/FPL-Core-Insights/commits/';
const CACHE_DIR = __DIR__ . '/../../storage/cache';
const LATEST_SECONDS = 1800;  // how long to trust "the latest data is ..." before asking again
const RETRY_SECONDS = 300;    // after a failed request (e.g. offline), wait this long before trying again

// The data folder's current commit, for a normal clone (.git folder) or a submodule (.git file).
function localCommit(): ?string
{
    $git = DATA_REPO . '/.git';
    if (is_file($git) && preg_match('/^gitdir:\s*(.+)$/m', (string) file_get_contents($git), $m)) {
        $git = DATA_REPO . '/' . trim($m[1]);
    }
    $head = trim((string) @file_get_contents("$git/HEAD"));
    if (preg_match('/^[0-9a-f]{40}$/', $head)) {
        return $head;  // detached, as after "git submodule update"
    }
    if (!preg_match('#^ref: (refs/heads/[\w.-]+)$#', $head, $m)) {
        return null;
    }
    $ref = trim((string) @file_get_contents("$git/{$m[1]}"));
    if (preg_match('/^[0-9a-f]{40}$/', $ref)) {
        return $ref;
    }
    foreach (@file("$git/packed-refs") ?: [] as $line) {
        if (preg_match('/^([0-9a-f]{40}) ' . preg_quote($m[1], '/') . '$/', trim($line), $p)) {
            return $p[1];
        }
    }
    return null;
}

// A commit's id and date from GitHub. $maxAge = 0 means cache forever (a commit's date never changes).
function commitInfo(string $ref, int $maxAge): ?array
{
    $file = CACHE_DIR . '/data-commit-' . preg_replace('/\W/', '', $ref) . '.json';
    if (is_file($file)) {
        $age = time() - filemtime($file);
        $cached = json_decode((string) file_get_contents($file), true);
        if (!empty($cached['sha']) && ($maxAge === 0 || $age < $maxAge)) {
            return $cached;
        }
        if (empty($cached['sha']) && $age < RETRY_SECONDS) {
            return null;
        }
    }

    $ctx = stream_context_create(['http' => [
        'timeout'       => 5,
        'ignore_errors' => true,
        'header'        => "User-Agent: fpl-points-tracker\r\nAccept: application/vnd.github+json\r\n",
    ]]);
    $body = @file_get_contents(API . $ref, false, $ctx);
    $data = $body ? json_decode($body, true) : null;
    $info = !empty($data['sha']) ? ['sha' => $data['sha'], 'date' => $data['commit']['committer']['date'] ?? null] : [];

    if (is_dir(CACHE_DIR) || @mkdir(CACHE_DIR, 0775, true)) {
        file_put_contents($file, json_encode($info), LOCK_EX);  // an empty answer means "failed, retry later"
    }
    return $info ?: null;
}

$sha = localCommit();
$local = $sha ? (commitInfo($sha, 0) ?? ['sha' => $sha, 'date' => null]) : null;
$latest = commitInfo('main', LATEST_SECONDS);

echo json_encode([
    'local'  => $local,
    'latest' => $latest,
    'behind' => $local && $latest && $local['date'] && $local['sha'] !== $latest['sha'] && $latest['date'] > $local['date'],
]);
