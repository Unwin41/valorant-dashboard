// Generated sample data in the same shape as the HenrikDev API responses.
// Used by `npm run demo` so the dashboard can be tried without an API key.
'use strict';

const MAPS = ['Ascent', 'Bind', 'Haven', 'Split', 'Lotus', 'Sunset', 'Icebox', 'Breeze'];
const AGENTS = ['Jett', 'Reyna', 'Omen', 'Sova', 'Killjoy', 'Sage', 'Raze', 'Clove'];
const MODE_LABELS = {
  competitive: 'Competitive',
  unrated: 'Unrated',
  swiftplay: 'Swiftplay',
  spikerush: 'Spike Rush',
  premier: 'Premier',
};

// Small seeded PRNG so the same Riot ID always gets the same demo matches.
function seeded(text) {
  let seed = 0;
  for (const ch of text) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) | 0;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

function account({ name, tag }) {
  return {
    status: 200,
    data: { puuid: 'demo-puuid', region: 'eu', account_level: 87, name, tag },
  };
}

function mmr({ name, tag }) {
  return {
    status: 200,
    data: {
      name,
      tag,
      current_data: { currenttierpatched: 'Platinum 2', ranking_in_tier: 47, images: {} },
      highest_rank: { patched_tier: 'Diamond 1' },
    },
  };
}

function matches({ name, tag }, region, mode) {
  const rand = seeded(`${name}#${tag}#${mode}`.toLowerCase());
  const favourites = [pick(rand, AGENTS), pick(rand, AGENTS), pick(rand, AGENTS)];
  let time = Math.floor(Date.now() / 1000) - 1800;

  const data = Array.from({ length: 10 }, (_, i) => {
    const won = rand() < 0.55;
    const otherRounds = Math.floor(rand() * 12);
    const roundsWon = won ? 13 : otherRounds;
    const roundsLost = won ? otherRounds : 13;
    const rounds = roundsWon + roundsLost;
    const kills = Math.round(rounds * (0.5 + rand() * 0.6) + (won ? 2 : 0));
    const deaths = Math.round(rounds * (0.55 + rand() * 0.35));
    const headshots = Math.round(kills * (1.2 + rand()));
    const team = rand() < 0.5 ? 'Red' : 'Blue';
    const other = team === 'Red' ? 'Blue' : 'Red';
    time -= Math.floor(3600 * (1 + rand() * 20));

    return {
      metadata: {
        matchid: `demo-${i}`,
        map: pick(rand, MAPS),
        mode: MODE_LABELS[mode] || pick(rand, ['Competitive', 'Competitive', 'Unrated', 'Swiftplay']),
        game_start: time,
        rounds_played: rounds,
      },
      players: {
        all_players: [{
          puuid: 'demo-puuid',
          name,
          tag,
          team,
          character: rand() < 0.7 ? favourites[0] : pick(rand, favourites),
          stats: {
            score: Math.round(kills * 150 + rand() * 1500 + rounds * 40),
            kills,
            deaths,
            assists: Math.round(rounds * rand() * 0.4),
            headshots,
            bodyshots: Math.round(headshots * (2.5 + rand() * 2)),
            legshots: Math.round(headshots * rand() * 0.4),
          },
        }],
      },
      teams: {
        [team.toLowerCase()]: { has_won: won, rounds_won: roundsWon, rounds_lost: roundsLost },
        [other.toLowerCase()]: { has_won: !won, rounds_won: roundsLost, rounds_lost: roundsWon },
      },
    };
  });

  return { status: 200, data };
}

module.exports = { account, mmr, matches };
