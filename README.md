# FPL Points Tracker

A web page to help you pick transfers and beat your mini league.

## What's on the screen

**Chart (top left).** Click any player to add them (up to 8). Switch between *Total* (running total) and *Per gameweek* (bars). *Clear* removes everyone.

On the *My league* tab the chart becomes the **league race**: you plus the top of the table (up to 8 lines). *Vs average* shows how far above or below the league average each manager is after every gameweek. It's the easiest way to see who's pulling away.

**Players (right), three tabs:**

| Tab | What it shows |
|---|---|
| All players | Every player. Click a column name to sort. Filter by position and price. Hover a column name, or open "What do the columns mean?", for an explanation. |
| My team | Pick a house team from the dropdown. Shows the squad, bench, money in the bank, overall rank and predicted points. |
| My league | Standings for one of your private leagues. Click a rival to compare against just them. |

**Panel under the chart** changes with the tab:

| Tab | Panel | What it does |
|---|---|---|
| All players | Quick picks | Hot + easy games, best value, due a goal, hidden gems |
| My team | Team advice | Captain pick, worries (injured, out of form, hard games), transfer ideas you can afford |
| My league | League advice | Threats (players your rivals have and you don't), your differentials, who rivals are captaining |

**Fixture colours:** green = easy, red = hard. CAPITALS = home game, small letters = away.

## How fixture difficulty works

Difficulty is about **the opponent** (like FPL's own ratings), worked out from expected goals (xG):

- Attackers are rated on how good the opponent's **defence** is. Defenders and keepers are rated on how good the opponent's **attack** is. Home games are a bit easier.
- Ratings are **opponent-adjusted**: xG against a weak defence counts for less than xG against a strong one.
- Every team starts from **last season's** ratings, pulled halfway back to average (squads change over the summer), and counted as if they'd already played 30 games. This season's matches gradually take over. Promoted teams start like last season's three weakest sides.
- Games are split into fifths: 1 = easiest, 5 = hardest.

### How we know it works

`tools/backtest_fixtures.py` replays past seasons week by week. Before each gameweek it rates teams using only earlier matches, predicts each team's xG, and measures the error against what really happened.

| Model | Error 2025/26 | Error 2026/27 so far |
|---|---|---|
| Know nothing (every team average) | 0.762 | 0.771 |
| First version (not adjusted, light use of last season) | 0.722 | 0.809 |
| **Current** | **0.711** | **0.767** |

The current model was better in 98–99% of bootstrap resamples, in both seasons. Single matches are very noisy, so even a good model only gets about 7% closer than "know nothing". Weighting recent games more was tested and made predictions slightly worse, so it isn't used.

Run it yourself: `python3 tools/backtest_fixtures.py FPL-Elo-Insights/data`

## Run it

```sh
cd app
dcu
```

Open http://localhost:8080

## Saved teams

Use **Edit teams** in the *My team* tab to add a name and FPL ID for each person. The list is saved on the server (`app/storage/teams.json`), so every device in the house sees it. It isn't password protected.

To find an ID, go to your "Points" page on the FPL site. The number in the address is your ID:
`fantasy.premierleague.com/entry/`**`1234567`**`/event/6`

## Update the data

Player stats and fixtures come from the `FPL-Elo-Insights` folder (updated twice a day upstream):

```sh
cd FPL-Elo-Insights && git pull
```

Teams and leagues are fetched live from the FPL website. League data is cached for 10 minutes.

## Files

| File | What it does |
|---|---|
| `app/docker-compose.yml` | Runs PHP's built-in web server on port 8080 |
| `app/public/index.html`, `style.css`, `app.js` | The page |
| `app/public/api/players.php` | Player stats from the CSVs |
| `app/public/api/fixtures.php` | Next 5 games for each team, with difficulty |
| `app/public/api/team.php` | A squad, bank and leagues from the FPL website |
| `app/public/api/league.php` | League standings and every rival's squad |
| `app/public/api/teams.php` | Saves the house team list |
| `tools/backtest_fixtures.py` | Tests the fixture difficulty model against past seasons |
