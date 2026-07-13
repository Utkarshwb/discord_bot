# Maithili Discord AI Bot — Render keepalive setup

This repo runs a Discord bot and exposes a small web server so hosting providers (like Render) treat it as a web service.

Why: Render free plans sleep after ~15 minutes of inactivity. To keep the service awake, use an external cron/uptime monitor to ping the `/keepalive` endpoint every 15 minutes.

Useful endpoints

- `/` — basic landing page
- `/health` — JSON health + `lastKeepalive`
- `/keepalive` — call this with `GET`/`HEAD` every 15 minutes (recommended)
- `/last-ping` — returns the ISO timestamp of the last keepalive

Example cron/monitor curl (every 15 minutes):

```bash
curl -fsS -m 10 "https://<your-app>.onrender.com/keepalive" || true
```

Render notes

- This project already contains a `Procfile` set to `web: npm start` so Render will run the web service.
- Render provides `PORT` automatically; the server listens on `process.env.PORT`.

Next steps

- Deploy to Render as a Web Service.
- Configure your external uptime monitor (e.g., cron-job.org, uptime.kuma, cronless.org, or any "ping every 15 minutes" service) to hit `/keepalive`.

If you'd like, I can run `npm install` and test the service locally here, or prepare a `render.yaml` if you want an Infrastructure-as-Code deployment file.
