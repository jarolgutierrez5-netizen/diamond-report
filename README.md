# ⚾ MLB Analytics Dashboard

A modern MLB analytics dashboard that combines live game data, betting odds, advanced projections, and AI-powered matchup analysis into one interface.

---

## Features

### Live Games
- Today's MLB schedule
- Live scores
- Game status updates
- Team records
- Inning-by-inning scoring
- Box scores

### Starting Pitchers
- Probable pitchers
- Handedness (LHP/RHP)
- ERA
- Win/Loss record
- Pitching matchup comparison

### Betting Information
- Moneyline odds
- Run line
- Over/Under totals
- Favorite/Underdog highlighting
- Odds comparison

### Team Data
- League standings
- Team statistics
- Recent performance
- Bullpen rankings
- Offensive rankings

### Player Information
- Starting lineups
- Batting order
- Injury status (when available)
- Individual player statistics

### AI Matchup Analysis *(Optional)*
Generate detailed game previews including:

- Win probability
- Expected score
- Moneyline edge
- Over/Under projection
- Starting pitcher advantage
- Bullpen comparison
- Offensive matchup
- Weather impact
- Park factors
- Key players to watch

---

# Data Sources

This project uses publicly available MLB data.

| Source | Purpose |
|---------|----------|
| MLB Stats API | Live scores, schedules, standings, player stats |
| MLB Probable Pitchers | Starting pitchers |
| DraftKings | Betting odds |
| Weather API | Game weather |
| FanGraphs | Advanced statistics *(optional)* |
| Baseball Savant | Statcast metrics *(optional)* |

---

# Tech Stack

- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- MLB Stats API
- Axios
- TanStack Query

---

# Installation

Clone the repository.

```bash
git clone https://github.com/yourusername/mlb-dashboard.git
```

Install dependencies.

```bash
npm install
```

Start the development server.

```bash
npm run dev
```

---

# Environment Variables

Create a `.env` file.

```env
VITE_ODDS_API_KEY=YOUR_API_KEY
VITE_WEATHER_API_KEY=YOUR_API_KEY
OPENAI_API_KEY=YOUR_API_KEY
```

Only the MLB Stats API is required.

---

# Available Scripts

Run locally.

```bash
npm run dev
```

Build production files.

```bash
npm run build
```

Preview production build.

```bash
npm run preview
```

Run linting.

```bash
npm run lint
```

---

# Project Structure

```
src/
│
├── components/
├── pages/
├── hooks/
├── services/
├── lib/
├── types/
├── utils/
├── assets/
└── App.tsx
```

---

# Current Dashboard

- Live Scores
- Standings
- Pitcher Report
- Starting Lineups
- Betting Odds
- Team Statistics

---

# Planned Features

## Betting Model

- Moneyline Projection
- Over/Under Projection
- Run Line Projection

## Prop Models

- Strikeout Predictions
- Home Run Predictions
- RBI Predictions
- Hits Predictions

## Team Models

- Bullpen Rating
- Offensive Rating
- Defensive Rating
- Recent Form
- Travel Fatigue

## Advanced Analytics

- Park Factors
- Weather Impact
- Umpire Trends
- Lefty/Righty Splits
- Expected Runs

## Daily Reports

- Best Bets
- Highest Value Games
- Biggest Upsets
- Top Pitching Matchups
- Highest Scoring Games

## Export

- Excel Reports
- PDF Reports
- CSV Export

---

# Deployment

This project can be deployed to:

- Vercel
- Netlify
- Cloudflare Pages
- GitHub Pages

The MLB Stats API works without authentication.

Only AI-powered matchup analysis requires an API key.

---

# Performance

- Cached API requests
- Lazy loading
- Responsive design
- Mobile friendly
- Dark mode support
- Fast page loading

---

# Roadmap

- [x] Live MLB Scores
- [x] Standings
- [x] Pitcher Report
- [x] Betting Odds
- [x] Starting Lineups
- [ ] AI Matchup Analysis
- [ ] Strikeout Model
- [ ] Home Run Model
- [ ] Betting Tracker
- [ ] Daily Best Bets
- [ ] Excel Export
- [ ] User Accounts
- [ ] Saved Favorites
- [ ] Historical Trends

---

# License

MIT License

---

# Disclaimer

This project is intended for educational and informational purposes only.

Sports betting involves risk. Use any projections or analytics responsibly.

The authors make no guarantee regarding betting outcomes.
