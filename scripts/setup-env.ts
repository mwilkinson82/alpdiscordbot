import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const PORT = Number(process.env.SETUP_PORT || 8798);
const envPath = path.resolve(".env.local");

const fields = [
  {
    key: "DISCORD_BOT_TOKEN",
    label: "Discord Bot Token",
    secret: true,
    help: "Discord Developer Portal -> your app -> Bot -> Token.",
  },
  {
    key: "DISCORD_CLIENT_ID",
    label: "Discord Client ID / Application ID",
    help: "Discord Developer Portal -> your app -> General Information -> Application ID.",
  },
  {
    key: "DISCORD_GUILD_ID",
    label: "Discord Server ID",
    defaultValue: "927273292354711613",
    help: "In Discord, enable Developer Mode, then right-click the server and copy Server ID.",
  },
  {
    key: "DISCORD_GENERAL_CHANNEL_ID",
    label: "Main Channel ID",
    defaultValue: "1484648401483206739",
    help: "Right-click the channel where welcomes/prompts should post and copy Channel ID.",
  },
  {
    key: "DISCORD_ANNOUNCEMENTS_CHANNEL_ID",
    label: "Announcements Channel ID",
    defaultValue: "1484648401483206739",
    help: "Use the same channel as above unless you want morning posts elsewhere.",
  },
  {
    key: "CONTRACTOR_CIRCLE_ROLE_IDS",
    label: "Contractor Circle Role ID",
    defaultValue: "1484648318662344985",
    help: "Right-click the Contractor Circle role and copy Role ID.",
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI API Key",
    secret: true,
    help: "Use the secure Codex key flow, or paste an existing key here locally.",
  },
  {
    key: "WEBHOOK_SECRET",
    label: "Webhook Secret",
    secret: true,
    generate: true,
    help: "Protects the call-recap webhook. Leave blank to auto-generate.",
  },
  {
    key: "TIMEZONE",
    label: "Schedule Timezone",
    defaultValue: "America/New_York",
    help: "Timezone for morning and daytime prompts.",
  },
  {
    key: "MORNING_POST_HOUR",
    label: "Morning Post Hour",
    defaultValue: "8",
    help: "24-hour local time. Use 7 or 8 for your morning message.",
  },
  {
    key: "DAYTIME_PROMPT_HOURS",
    label: "Daytime Prompt Hours",
    defaultValue: "10,13,16",
    help: "Comma-separated 24-hour times for conversation prompts.",
  },
  {
    key: "ENABLE_WEEKEND_POSTS",
    label: "Weekend Posts",
    defaultValue: "false",
    help: "Use true only if the bot should post on weekends.",
  },
  {
    key: "OPENAI_MODEL",
    label: "OpenAI Model",
    defaultValue: "gpt-5.5",
    help: "Default model for recaps and prompts.",
  },
];

type Field = (typeof fields)[number];

function parseEnv(raw: string) {
  const result = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    result.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return result;
}

async function readExistingEnv() {
  if (!existsSync(envPath)) return new Map<string, string>();
  const raw = await readFile(envPath, "utf8");
  return parseEnv(raw);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function envValue(field: Field, existing: Map<string, string>) {
  return existing.get(field.key) || field.defaultValue || "";
}

async function renderPage(saved = false) {
  const existing = await readExistingEnv();
  const rows = fields
    .map((field) => {
      const existingValue = envValue(field, existing);
      const value = field.secret ? "" : existingValue;
      const placeholder = field.secret && existingValue ? "Already saved. Leave blank to keep it." : "";
      return `
        <label>
          <span>${escapeHtml(field.label)}</span>
          <input
            name="${field.key}"
            type="${field.secret ? "password" : "text"}"
            value="${escapeHtml(value)}"
            placeholder="${escapeHtml(placeholder)}"
            autocomplete="off"
          />
          <small>${escapeHtml(field.help)}</small>
        </label>
      `;
    })
    .join("\n");

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>ALP Discord Bot Setup</title>
      <style>
        :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        body { margin: 0; background: #101214; color: #f5f1e8; }
        main { max-width: 820px; margin: 0 auto; padding: 40px 20px 64px; }
        h1 { font-size: 28px; line-height: 1.15; margin: 0 0 10px; }
        p { color: #c9c1b3; line-height: 1.55; }
        a { color: #e4ae72; }
        form { display: grid; gap: 18px; margin-top: 28px; }
        label { display: grid; gap: 7px; }
        span { font-weight: 700; }
        input { width: 100%; box-sizing: border-box; border: 1px solid #3b3e42; border-radius: 8px; padding: 13px 12px; font-size: 15px; background: #181b1f; color: #fff; }
        small { color: #9d958b; line-height: 1.4; }
        button { appearance: none; border: 0; border-radius: 8px; padding: 14px 16px; font-weight: 800; background: #e4ae72; color: #15110d; cursor: pointer; }
        .notice { border: 1px solid #466b55; background: #17241c; color: #d8f3df; padding: 12px 14px; border-radius: 8px; }
        .links { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
        .links a { border: 1px solid #3b3e42; border-radius: 8px; padding: 10px 12px; text-decoration: none; background: #181b1f; }
      </style>
    </head>
    <body>
      <main>
        <h1>ALP Discord Bot Setup</h1>
        <p>This page writes the values into <code>.env.local</code> on this Mac. It does not commit secrets to GitHub, and blank secret fields preserve anything already saved.</p>
        <div class="links">
          <a href="https://discord.com/developers/applications" target="_blank">Open Discord Developer Portal</a>
          <a href="https://platform.openai.com/api-keys" target="_blank">Open OpenAI API Keys</a>
        </div>
        ${saved ? `<p class="notice">Saved. You can close this tab when you are done.</p>` : ""}
        <form method="post" action="/save">
          ${rows}
          <button type="submit">Save Bot Settings</button>
        </form>
      </main>
    </body>
  </html>`;
}

async function saveEnv(form: URLSearchParams) {
  const existing = await readExistingEnv();
  const lines = [
    "# Local secrets for ALP Discord Bot.",
    "# This file is ignored by Git.",
    "",
  ];

  for (const field of fields) {
    let value = String(form.get(field.key) || "").trim();
    if (!value && field.secret && existing.has(field.key)) {
      value = existing.get(field.key) || "";
    }
    if (!value && field.generate) {
      value = randomBytes(32).toString("hex");
    }
    if (!value && field.defaultValue) {
      value = field.defaultValue;
    }
    lines.push(`${field.key}=${value}`);
  }

  lines.push("PORT=8787", "DATA_DIR=./data", "LOG_LEVEL=info", "");
  await writeFile(envPath, `${lines.join("\n")}`, { encoding: "utf8", mode: 0o600 });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET") {
      const html = await renderPage(req.url?.includes("saved=1"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "POST" && req.url === "/save") {
      let body = "";
      for await (const chunk of req) body += chunk;
      await saveEnv(new URLSearchParams(body));
      res.writeHead(303, { location: "/?saved=1" });
      res.end();
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (error: any) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Setup failed: ${error?.message || "Unknown error"}`);
  }
});

server.listen(PORT, () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`ALP Discord Bot setup page: ${url}`);
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  }
});
