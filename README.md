# Teams Chat Extractor (Node script)

A dependency-free Node.js CLI that exports your Microsoft Teams chat history to local JSON files via the Microsoft Graph API. This is a Node port of the Python/Tkinter version at [Teams-chat-extractor](https://github.com/ujwal5555/Teams-chat-extractor) (adjust the link if the repo lives elsewhere).

Requires **Node 18+** (uses the built-in `fetch`).

## Usage

```bash
node script.js --token="<your-access-token>"
```

### Options

| Flag        | Required | Description                                                                 |
|-------------|----------|------------------------------------------------------------------------------|
| `--token`   | yes      | Bearer token for Microsoft Graph (`https://graph.microsoft.com/.default` / `Chat.Read` scope). |
| `--start`   | no       | Only include messages on/after this date (`YYYY-MM-DD`).                    |
| `--end`     | no       | Only include messages on/before this date (`YYYY-MM-DD`).                   |
| `--out`     | no       | Output directory. Defaults to `./data`.                                     |
| `--retry`   | no       | Retry only the chats listed in `<out>/failures.json` from a previous run.   |

`MS_GRAPH_API_BASE_URL` env var overrides the default `https://graph.microsoft.com/v1.0` base URL if set.

## What it does

1. Calls `GET /me/chats`, paginating through `@odata.nextLink`, to list all of the token owner's chats.
2. For each chat, calls `GET /me/chats/{id}/messages`, again paginating through all pages.
3. Optionally filters messages by `createdDateTime` against `--start`/`--end`.
4. Writes each chat's messages to `<out>/chat_<first6ofid>.json`.

## Resilience

- **Retries**: Transient failures (`429`, `503`, and network errors) are retried with backoff, honoring the `Retry-After` header when present, up to 8 attempts.
- **No silent data loss**: If a chat's messages can't be fully paginated even after retries, whatever was fetched is still saved — but as `chat_<id>.partial.json` instead of `chat_<id>.json`, so a `.json` file always means "fully downloaded."
- **Resumable**: Any chat that ends up incomplete has its full chat ID (not just the truncated filename prefix) recorded in `<out>/failures.json`. Run the script again with `--retry` to re-fetch only those chats:

  ```bash
  node script.js --token="<your-access-token>" --retry --out=./data
  ```

  A successful retry removes the chat from `failures.json`; the file is deleted entirely once nothing is left to retry.

## Exit codes

- `0` — all chats downloaded completely.
- `1` — fatal error (missing token, couldn't fetch the chat list, unexpected exception).
- `2` — finished, but one or more chats are only partial (see `failures.json`).

## Known limitations

- No OAuth flow — you must supply your own bearer token (e.g. via [Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer) or your own app registration).
- Only fetches the token owner's own chats (`/me/chats`), not tenant-wide chat data.
