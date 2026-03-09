# Random Chat

Minimal Omegle-style text chat MVP built with React, Vite, Tailwind CSS v4, Express, and Socket.IO.

## Structure

```text
chat/
├─ client/
│  ├─ index.html
│  ├─ package.json
│  ├─ vite.config.js
│  └─ src/
│     ├─ App.jsx
│     ├─ index.css
│     └─ main.jsx
├─ server/
│  ├─ package.json
│  └─ server.js
└─ README.md
```

## Run locally

### One command (recommended)

```bash
cd chat
npm run dev
```

This installs missing dependencies (client + server) and starts both apps.

### Backend

```bash
cd server
npm install
node server.js
```

### Frontend

```bash
cd client
npm install
npm run dev
```

Open multiple browser tabs at the Vite URL to simulate different users.

## Security Setup

The server includes production safeguards:

- `helmet` security headers
- HTTP rate limiting (`express-rate-limit`)
- Strict origin allowlist for HTTP + Socket.IO via `CLIENT_ORIGIN`
- Socket event throttling (`start`, `message`, `next`, `stop`)
- Message sanitization (URL blocking + profanity masking)
- Temporary IP blocking after repeated abuse attempts

### Required Environment Variables

Backend (`server/.env`):

```bash
PORT=3001
NODE_ENV=production
CLIENT_ORIGIN=https://your-frontend-domain.vercel.app
TRUST_PROXY=1
```

Frontend (`client/.env`):

```bash
VITE_SERVER_URL=https://your-backend-domain.onrender.com
```

`CLIENT_ORIGIN` supports multiple allowed origins with comma-separated values.
