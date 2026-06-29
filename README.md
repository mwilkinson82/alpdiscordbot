# ALP Discord Bot

Standalone Discord bot for the ALP Contractor Circle community.

It replaces the narrow Manus-era bot with a clean service that can:

- welcome new Discord members
- recognize Contractor Circle roles
- post a morning message
- keep the room active with scheduled conversation prompts that can be AI-generated around practical daypart goals
- accept call transcript/notes webhooks and post a recap
- answer direct mentions, direct replies, and `/ask` questions as ALP Think
- support slash commands for manual recaps, prompts, and leaderboards
- track activity in a local JSON store as a foundation for future leaderboards
- post construction/business quizzes and track quiz points
- estimate member active time from messages and quiz participation

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

- Gateway intents: `Guilds`, `Guild Members`, `Guild Messages`
- Bot permissions: send messages, read message history, use slash commands, manage roles if assigning Contractor Circle roles

Enable **Server Members Intent** in the Discord Developer Portal so the bot can welcome new members. Message Content Intent is optional and off by default.

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

## Targeted Prompt Webhook

POST to `/webhooks/targeted-prompt` with header `x-webhook-secret: <WEBHOOK_SECRET>` when ALP Think should ask one member a direct follow-up and watch for their answer.

```json
{
  "targetUserId": "1243955897475010652",
  "targetName": "Caleb Morrow",
  "content": "<@1243955897475010652> Caleb, how is your IOR going on that project since the meeting?",
  "channelId": "1484648401483206739"
}
```

If the target member responds in that channel within the configured response window, ALP Think can reply in context.

## Quiz Webhook

POST to `/webhooks/quiz` with header `x-webhook-secret: <WEBHOOK_SECRET>` to have ALP Think generate and post a quiz.

```json
{
  "topic": "IOR and project risk",
  "difficulty": "medium",
  "channelId": "1484648401483206739"
}
```

## Slash Commands

- `/recap` creates a call recap from pasted notes or transcript
- `/prompt` posts a conversation starter
- `/leaderboard` shows recent activity
- `/goodmorning` posts the daily morning message
- `/ask` asks ALP Think a question
- `/quiz` posts a construction/business quiz
- `/answer` answers the latest open quiz in the channel
- `/quizleaderboard` shows quiz points
- `/activetime` shows estimated Discord active time

The bot only answers when someone mentions it, replies directly to one of its messages, or uses `/ask`.

`/activetime` is an estimate based on messages and quiz participation windows. Discord does not expose private read time or exact time spent looking at the server.

## Scheduled Prompt Cadence

By default, scheduled daytime prompts use OpenAI with fixed guardrails:

- late morning: the morning is almost over; push well to 1:00
- after lunch: lunch is over; push to 2:00 or 4:00
- late afternoon: get a coffee if needed; push to 6:00

Set `SCHEDULED_PROMPTS_USE_AI=false` to use the fixed fallback prompts instead.

## Deployment Notes

This bot is an always-on worker, so deploy it somewhere that supports long-running Node processes.
Good fits include Railway, Render worker services, Fly.io, a small VPS, or a container on Google Cloud Run with CPU always allocated.

Set production environment variables in the host's secret manager, not in GitHub.
