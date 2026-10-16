# FPL Points Tracker

A web page to help you pick transfers and beat your mini league.

## What's on the screen

**Chart (top left).** Click any player to add them (up to 8). Switch between *Total* (running total) and *Per gameweek* (bars).

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

Each team gets an attack and a defence rating from the expected goals (xG) in this season's matches. For every upcoming game we estimate goals for and against. Attackers are rated on goals their team should score; defenders and keepers on goals they should let in. Games are split into fifths: 1 = easiest, 5 = hardest. Early in the season the ratings are pulled towards average so a few lucky games don't count too much.

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
