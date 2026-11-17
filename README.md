# Valorant Stats Dashboard

A local dashboard that shows your recent Valorant matches: win rate, K/D, average combat score (ACS), headshot %, rank, and charts by agent and map.

Data comes from the unofficial [HenrikDev Valorant API](https://docs.henrikdev.xyz). Riot's official Valorant match API needs a production key, so it isn't practical for a personal project.

## Try it without a key

```
npm run demo
```

Open http://localhost:3000 and search any `Name#Tag`. Demo mode shows generated sample data.

## Use your real stats

1. Get a free API key: join the HenrikDev Discord (linked from https://docs.henrikdev.xyz) and generate a basic key there.
2. Copy `.env.example` to `.env` and paste the key after `HENRIK_API_KEY=`.
3. Run `npm start` and open http://localhost:3000.
4. Enter your Riot ID as `Name#Tag`. Region "Auto" detects it from your account.

There are no packages to install; it only needs Node.js 20.12 or newer.

## How it works

- `server.js` serves the page and forwards `/api/*` requests to HenrikDev with your key, so the key never reaches the browser. Successful responses are cached for 60 seconds to stay under the rate limit.
- `public/app.js` fetches your account, rank and last 10 matches, then computes the stats and draws the charts (Chart.js).
- Agent portraits, map images and rank icons come from [valorant-api.com](https://valorant-api.com), which needs no key. The page loads them straight from the browser; if that site is down, the dashboard still works without images.
- `demo.js` generates sample data in the same shape as the real API.

## Notes

- The API returns your last 10 matches per request. Changing the mode filter fetches the last 10 of that mode.
- Deathmatch has no team result, so those games show "–" and don't count toward win rate.
- HenrikDev is unofficial and can change. All field mapping lives in `normalizeMatch()` in `public/app.js`, which is the place to fix things if the response shape changes.
- Not affiliated with Riot Games.
