# Replit App Starter Template

A blank Express + SQLite template ready for customization. Import this into Replit and start building immediately.

## What's Included

- **Express.js** server with REST API boilerplate
- **SQLite** database with auto-creating schema
- **Tailwind CSS** via CDN (no build step)
- **Dark mode UI** with glass-morphism styling
- **Sample CRUD routes** to get you started

## Quick Start

1. Import this template into Replit
2. Click "Run"
3. Your app is live!

No configuration needed. The database creates itself on first run.

## File Structure

```
├── server.js          # Main application logic
├── views/
│   └── index.html     # Frontend UI
├── db/
│   └── app.db         # SQLite database (auto-created)
├── package.json       # Dependencies
├── .replit            # Replit configuration
└── replit.nix         # Environment setup
```

## Customization Guide

### 1. Define Your Database Schema

Edit the `initDatabase()` function in `server.js`:

```javascript
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS your_table (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
```

### 2. Add API Routes

Add new endpoints in the ROUTES - API section:

```javascript
app.get('/api/your-endpoint', (req, res) => {
  // Your logic here
  res.json({ data: 'example' });
});
```

### 3. Build Your UI

Edit `views/index.html` to create your interface. The template uses:
- Tailwind CSS for styling
- Vanilla JavaScript for interactivity
- Fetch API for backend calls

### 4. Add External APIs (Optional)

1. Add API keys in Replit's **Secrets** tab
2. Access them via `process.env.YOUR_API_KEY`
3. Always include mock data fallbacks:

```javascript
async function fetchData() {
  if (!process.env.API_KEY) {
    return getMockData(); // Fallback for demo mode
  }
  // Real API call
}
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Main application page |
| `/api/items` | GET | List all items |
| `/api/items` | POST | Create new item |
| `/api/items/:id` | PUT | Update item |
| `/api/items/:id` | DELETE | Delete item |
| `/api/health` | GET | Health check |

## Tech Stack

- **Runtime:** Node.js 20
- **Backend:** Express.js
- **Database:** SQLite via better-sqlite3
- **Frontend:** HTML + Tailwind CSS
- **Environment:** dotenv for local, Replit Secrets for production

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 5000) |

Add your own API keys as needed in the Secrets tab.

## Tips

- **Mock data first:** Always build with mock data, then add real APIs
- **Keep it simple:** This stack requires no build step
- **Use Replit AI:** Ask the chat to help modify code
- **Database resets:** Delete `db/app.db` to start fresh

---

Built for Replit App Builder
