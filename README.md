# ALP Discord Bot

Standalone Discord bot for the ALP Contractor Circle community.

It replaces the narrow Manus-era bot with a clean service that can:

- welcome new Discord members
- recognize Contractor Circle roles
- post a morning message
- keep the room active with scheduled conversation prompts
- accept call transcript/notes webhooks and post a recap
- support slash commands for manual recaps, prompts, and leaderboards
- track activity in a local JSON store as a foundation for future leaderboards

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Open the local setup page:

   ```bash
   npm run setup:env
   ```

   This opens a browser form that saves `.env.local` for you.

   Or create a local env file manually:

   ```bash
   cp .env.example .env.local
   ```

3. Fill in `.env.local` with Discord and OpenAI credentials. Do not commit real secrets.
   In production, set `WEBHOOK_SECRET`; webhook calls are rejected without it.

4. Register slash commands with Discord:

   ```bash
   npm run register:commands
   ```

5. Run locally:

   ```bash
   npm run dev
   ```

## Discord Developer Portal

The bot needs these permissions and intents:

- Gateway intents: `Guilds`, `Guild Members`, `Guild Messages`, `Message Content`
- Bot permissions: send messages, read message history, use slash commands, manage roles if assigning Contractor Circle roles

If role assignment fails, move the bot role above the Contractor Circle role in Discord's role list.

## Call Recap Webhook

POST to `/webhooks/call-recap` with header `x-webhook-secret: <WEBHOOK_SECRET>`.

```json
{
  "title": "Weekly Contractor Circle Call",
  "speaker": "Marshall",
  "transcript": "Paste transcript or notes here...",
  "channelId": "1484648401483206739"
}
```

The bot will generate a concise recap and a discussion question, then post it to Discord.

## Slash Commands

- `/recap` creates a call recap from pasted notes or transcript
- `/prompt` posts a conversation starter
- `/leaderboard` shows recent activity
- `/goodmorning` posts the daily morning message

## Deployment Notes

This bot is an always-on worker, so deploy it somewhere that supports long-running Node processes.
Good fits include Railway, Render worker services, Fly.io, a small VPS, or a container on Google Cloud Run with CPU always allocated.

Set production environment variables in the host's secret manager, not in GitHub.
