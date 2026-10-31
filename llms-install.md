# Installing the Transcript Dock MCP server (for AI agents)

Two ways to connect. Prefer the hosted one: nothing to install and no key to copy.

## Option 1: hosted server (recommended)

Add a remote (Streamable HTTP) MCP server with this exact URL:

```
https://www.transcriptdock.com/mcp
```

Use the `www` host exactly: the apex domain redirects, and clients drop the `Authorization` header on a cross origin redirect. The server supports OAuth 2.1 (dynamic client registration, PKCE), so the user signs in to Transcript Dock in the browser when the client asks. No API key is needed.

If the client cannot do OAuth, send the user's API key as a header instead:

```json
{
  "mcpServers": {
    "transcriptdock": {
      "url": "https://www.transcriptdock.com/mcp",
      "headers": { "Authorization": "Bearer td_live_..." }
    }
  }
}
```

## Option 2: local stdio server (npx)

Requires Node.js 22.15 or newer. Ask the user for their API key (Transcript Dock dashboard, Developer, API keys; it starts with `td_live_`). Never invent one.

```json
{
  "mcpServers": {
    "transcriptdock": {
      "command": "npx",
      "args": ["-y", "@transcriptdock/mcp"],
      "env": {
        "TRANSCRIPTDOCK_API_KEY": "td_live_...",
        "TRANSCRIPTDOCK_BASE_URL": "https://www.transcriptdock.com"
      }
    }
  }
}
```

Both variables are required. The server exits with a clear message if the key is missing.

## Check it works

Call `get_video_transcript` with a public YouTube video URL. A free account gets 50 caption credits a month; one caption transcript costs 1 credit. AI transcription (mode `auto` or `transcribe`, and every Instagram Reel) needs a paid plan and otherwise answers 402 `PLAN_REQUIRED`.
