# Fuel — UK Fuel Card Account Management Platform

## Overview
A UK-focused fuel card account management platform that helps businesses and drivers manage fuel card accounts, track spend, and find fuel stations using official GOV.UK Fuel Finder data.

## Architecture
- **Frontend**: Static HTML/CSS/JS files served from the project root on port 5000 (`serve.mjs`)
- **Backend**: Node.js Express API server in `server/` on port 8080

## Project Structure
```
.
├── css/                   # Frontend stylesheets
├── js/                    # Frontend logic (api-config.js, auth-client.js, etc.)
├── server/                # Node.js backend (Express)
│   ├── lib/               # Shared logic (auth, fuel snapshots, users repo, brentCrude, fuelForecast)
│   ├── routes/            # Express.js route handlers (auth, fuel, forecast)
│   ├── scripts/           # Utility scripts
│   ├── supabase/          # Backend-specific SQL schema
│   ├── .env               # Environment config (AUTH_SECRET, PORT=8080)
│   └── server.mjs         # Entry point
├── serve.mjs              # Static file server for frontend (port 5000)
├── index.html             # Landing page
├── app.html               # Main authenticated app shell (Fuel Snapshot)
├── fuel-forecast.html     # Fuel price forecast page (Brent crude vs diesel)
├── fuel-prices-history.html # Historical fuel price data
├── user-price-trend.html  # Personalised "My Price Trend" chart
├── login.html             # Login page
└── signup.html            # Signup page
```

## Key Configuration
- **Frontend port**: 5000 (served by `serve.mjs`)
- **Backend port**: 8080 (configured via `server/.env` PORT=8080)
- **API URL override**: `js/api-config.js` auto-detects Replit proxy and points to port 8080
- **Auth mode**: Local file-based auth (`users.json`) using `AUTH_SECRET` in `server/.env`
- **Dev auth**: Enabled (`FUEL_ALLOW_DEV_AUTH=true`) — POST `/auth/dev-session` bypasses login

## Running
Single workflow "Start application" runs both services:
```
node serve.mjs & (cd server && node server.mjs)
```

## Database
- Default: Local `server/users.json` file (no database needed)
- Optional: Supabase (set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY in `server/.env`)

## External APIs
- GOV.UK Fuel Finder API (optional): Set `FUEL_CLIENT_ID` and `FUEL_CLIENT_SECRET` in `server/.env`

## Backend Dependencies
- express, cors, dotenv, @supabase/supabase-js

## Features
- **User Authentication**: Local file-based auth (email/password signup)
- **Fuel Snapshot**: Dashboard showing current fuel prices and account overview
- **Fuel Price History**: Store and view daily fuel price snapshots
- **My Price Trend**: Personalised price tracking per user card
- **Fuel Price Forecast**: Brent crude oil vs UK diesel pump price analysis with Buy Now/Wait/Hold signals
- **Webhooks**: API endpoints for fuel price data ingestion

## Fuel Forecast System
- **Brent crude data**: `server/lib/brentCrude.mjs` — fetches/stores crude oil prices, converts $/barrel to p/litre, persisted in `server/brent-crude-history.json`; uses synthetic fallback data when no real API succeeds
- **Forecast engine**: `server/lib/fuelForecast.mjs` — spread-and-lag heuristic comparing crude cost movements to retail pump trends; outputs direction (up/down/stable), confidence (low/medium/high), and recommendation (Buy Now/Wait/Hold)
- **API endpoint**: `GET /forecast` (auth required) — returns forecast signal + chart data + spread metrics
- **Refresh**: Brent crude data refreshes alongside the fuel snapshot cycle (up to 4x/day), or every 6 hours standalone if no Fuel Finder credentials configured
- **Frontend**: `fuel-forecast.html` — Chart.js line chart, signal card, recommendation badge, key metrics

## API Endpoints
- **Auth**: `/auth/register`, `/auth/login`, `/auth/me`, `/auth/profile`, `/auth/dev-session`
- **Fuel Data**: `/nearby`, `/prices`, `/fuel-type`, `/brand`, `/status`
- **Forecast**: `/forecast` (GET, auth required), `/forecast/refresh-crude` (POST)
- **Webhooks**: `/webhooks/fuel-prices/history` (retrieve price history)

## Deployment
Configured as autoscale deployment running both frontend and backend processes.
