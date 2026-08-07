# @page-agent/soldier-mcp

MCP server that drives the OpenHuman on-page avatar (`window.playAnimation`) over a
direct WebSocket. It replaces the standalone Python `soldier_mcp_server.py`: an agent
calls the `play_animation` tool, the server pushes a `soldier_command` frame to the
browser, and the page's `useSoldierSocket` hook runs the animation and reports back.

```
Agent --MCP(stdio)--> soldier-mcp (Node, listen :38402)
                         └─ SoldierHub (WS server, /ws/<userId>)
                              ↑ WS (the browser reverse-connects)
                      OpenHuman page useSoldierSocket --> window.playAnimation()
```

Unlike page-agent's MCP (extension hub reverse-connects, addressed as one peer), the
avatar is per-browser: each OpenHuman page opens `ws://<host>:38402/ws/<userId>`, so the
server keys connections by `userId` and fans out to many browsers.

## Run

```bash
# stdio MCP server; opens the WS hub on port 38402
npx soldier-mcp
# or override the port
PORT=38402 node packages/soldier-mcp/src/index.js
```

MCP client config (stdio):

```json
{
    "mcpServers": {
        "soldier": { "command": "npx", "args": ["soldier-mcp"] }
    }
}
```

## Tools

| Tool               | Args                   | Description                                                       |
| ------------------ | ---------------------- | ----------------------------------------------------------------- |
| `play_animation`   | `animation`, `userId?` | Play a clip on the avatar; blocks until the browser reports back. |
| `list_connections` | –                      | List connected avatar `userId`s.                                  |
| `get_status`       | –                      | `{ connected, connections }`.                                     |

`userId` defaults to `58be57a5-1330-4281-b1d2-cfda6321c327`, matching
`OpenHumanAgent`'s `DEFAULT_SOLDIER_USER_ID`.

## Protocol

Must match `packages/openhuman/src/hooks/useWebSocket.ts`:

- Browser connects: `ws://localhost:38402/ws/<userId>`
- server → browser: `{ type: 'soldier_command', payload: { animation } }`
- browser → server: `{ type: 'soldier_result', payload: { result } }`

The result frame carries no correlation id, so at most one animation may be in flight per
connection; a second command for the same `userId` while one is pending is rejected.
Different `userId`s run concurrently. A command times out after 15s.

## Browser side

Mount `OpenHumanAgent` (from `@page-agent/openhuman`) in the target page. Its
`SoldierViewer` exposes `window.playAnimation`, and `useSoldierSocket` connects to this
server automatically. Override the URL via the `soldierWsUrl` prop or the
`VITE_OPENHUMAN_SOLDIER_WS` env var.
