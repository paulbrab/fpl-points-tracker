# FPL Points Tracker

A small web page for comparing FPL players' total points over the season.

- **Left:** chart of cumulative points per gameweek.
- **Right:** player list. Click a player to add or remove them from the chart (up to 8).
- **My team tab:** enter your FPL team ID to list your current squad.

## Run it

```sh
cd app
dcu
```

Open http://localhost:8080

## Update the data

Player points come from the `FPL-Elo-Insights` folder (refreshed twice a day upstream):

```sh
cd FPL-Elo-Insights && git pull
```

Your team is fetched live from the FPL website each time you press **Load team**.

## Finding your team ID

Go to your "Points" page on the FPL site. The number in the address is your ID:
`fantasy.premierleague.com/entry/`**`1234567`**`/event/6`

## Files

| File | What it does |
|---|---|
| `app/docker-compose.yml` | Runs PHP's built-in web server on port 8080 |
| `app/public/index.html`, `style.css`, `app.js` | The page |
| `app/public/api/players.php` | Reads the CSVs and returns each player's points per gameweek |
| `app/public/api/team.php` | Fetches your squad from the FPL website |
