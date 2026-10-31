# TranscriptDock MCP server

An MCP server that wraps the TranscriptDock public API, so Claude, Cursor and other agents can submit transcription jobs and read back transcripts without you leaving the chat.

It only calls the public `/v1` API ([API reference](https://www.transcriptdock.com/docs/api-reference)). The hosted server signs you in with OAuth; the local one needs a TranscriptDock API key (`td_live_...`).

## Remote (no install)

The hosted server is `https://www.transcriptdock.com/mcp` (Streamable HTTP). Use that exact URL: the apex domain redirects, and clients drop the `Authorization` header on a cross origin redirect.

### Claude (claude.ai, Desktop, mobile)

Open Customize, Connectors, choose Add custom connector, and paste `https://www.transcriptdock.com/mcp`. Choose Add, then Connect, sign in to TranscriptDock and allow access. No API key needed: the server publishes RFC 9728 metadata and signs people in through OAuth 2.1 (dynamic client registration, S256 PKCE). An OAuth connection can read and submit jobs and read transcripts, nothing else.

### Claude Code and other clients

```bash
claude mcp add --transport http transcriptdock https://www.transcriptdock.com/mcp
```

Then run `/mcp` and choose Authenticate. To use an API key instead, send it as a bearer header:

```bash
claude mcp add --transport http transcriptdock https://www.transcriptdock.com/mcp \
  --header "Authorization: Bearer td_live_..."
```

```json
{ "mcpServers": { "transcriptdock": { "url": "https://www.transcriptdock.com/mcp", "headers": { "Authorization": "Bearer td_live_..." } } } }
```

Ask for a video and the agent calls `get_video_transcript(url)`: submit, wait, text back in one tool call.

## Install locally (npx)

### Claude Desktop (stdio)

Claude Desktop users can add the remote connector above instead. For the local server, add this to your Claude Desktop config (Settings, Developer, Edit config):

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

### Claude Code

```
claude mcp add --transport stdio transcriptdock --env TRANSCRIPTDOCK_API_KEY=td_live_... --env TRANSCRIPTDOCK_BASE_URL=https://www.transcriptdock.com -- npx -y @transcriptdock/mcp
```

### Cursor

Add a server in Cursor Settings, MCP, using the same command and environment variables:

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

## Sources and modes

`mode` defaults to `captions_only`: the existing captions of a YouTube or TikTok video, 1
credit each. AI transcription (`auto`/`transcribe` modes, 2 credits per started minute)
needs a paid plan, so the trial answers 402 `PLAN_REQUIRED`. Instagram Reels (beta) have no
caption path: send them with `mode: "auto"` or `"transcribe"`; `captions_only` answers 422
`CAPABILITY_UNAVAILABLE`. `GET /v1/capabilities` lists what your plan can do. For local
development use a loopback URL such as `http://127.0.0.1:3000` for `TRANSCRIPTDOCK_BASE_URL`.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `TRANSCRIPTDOCK_API_KEY` | yes | Your workspace API key. The server exits with a clear message if it is missing. |
| `TRANSCRIPTDOCK_BASE_URL` | yes | Explicit HTTPS API origin, `https://www.transcriptdock.com`. HTTP is allowed only for loopback local development. |

## Tools

- `get_video_transcript`: submit, wait and return the transcript text (or srt, vtt, segments) in one call. Example prompt: "What does this video say?"
- `transcribe`: submit a video or audio URL and get back the created job. Example prompt: "Transcribe this YouTube link and give me the SRT."
- `get_job`: look up a job's status, stage, error, and billing by ID. Example prompt: "Check on job 11111111-1111-4111-8111-111111111111."
- `get_transcript`: fetch a completed transcript as normalized JSON segments or as a text, SRT, or VTT export. Example prompt: "Get the VTT for transcript 22222222-2222-4222-8222-222222222222."
- `list_jobs`: list jobs for the workspace, newest first, with cursor pagination. Example prompt: "Show my last 10 transcription jobs."
- `wait_for_job`: poll a job every few seconds until it succeeds, fails, or is cancelled, then return it. Example prompt: "Transcribe this TikTok and wait until it is done."
- `search_youtube`: search YouTube by query with cursor paging. Example prompt: "Search YouTube for lofi study music and transcribe the top result"
- `list_channel_videos`: list videos from one channel with cursor paging. Example prompt: "List the latest videos from @veritasium"
- `get_channel_latest_videos`: get the latest videos from one channel newest first with no cursor input. Example prompt: "Find the latest five videos on @veritasium and transcribe the first one"
- `search_channel_videos`: search within one channel by query with cursor paging. Example prompt: "Search @veritasium for black holes and transcribe the best match"
- `list_playlist_videos`: list videos from one playlist with cursor paging. Example prompt: "List the videos in this playlist and transcribe the first one"
- `list_tiktok_user_videos`: list up to 10 videos from one TikTok profile with the profile stats. TikTok search and further pages are not available. Set `include_details` to fetch each video page for full stats, dates, hashtags, and music. Example prompt: "List the latest TikTok videos from @tiktokuser"
- `get_video_discovery`: get one video discovery by ID. Example prompt: "Check on my latest video discovery and show the video list"

Each listing tool creates one video discovery with a generated idempotency key then polls to completion with a bounded timeout. A timeout returns the last body with a flag and a hint to call `get_video_discovery`. A failed discovery returns an error result with the error object.

Every response is the raw API payload, pretty printed as JSON, except `get_transcript` with `format: text`, `srt`, or `vtt`, which returns the export file body directly. API errors come back as a readable tool error with the error code, message, and request ID; the API key is never included in output.

## Development

```
npm install
npm run typecheck
npm run build
npm test
npm run dev
```

## License

MIT
