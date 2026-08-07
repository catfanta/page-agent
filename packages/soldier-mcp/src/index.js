#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'

import { SoldierHub } from './soldier-hub.js'

/**
 * Default connection id. Mirrors OpenHumanAgent.tsx's DEFAULT_SOLDIER_USER_ID
 * (and the Python server's SOLDIER_DEFAULT_USER_ID it replaces), so an agent
 * that omits `userId` reaches the default browser without extra config.
 */
const DEFAULT_SOLDIER_USER_ID = '58be57a5-1330-4281-b1d2-cfda6321c327'

/** @param {unknown} data */
function ok(data) {
	return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}
/** @param {Error} err */
function fail(err) {
	return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
}

const env = process.env
const port = parseInt(env.PORT || '38402')

// --- WebSocket hub (browsers reverse-connect here) ---

const hub = new SoldierHub(port)
await hub.start()

// --- MCP server (stdio) ---

const mcpServer = new McpServer({ name: 'soldier-mcp', version: '1.8.0' })

mcpServer.registerTool(
	'play_animation',
	{
		description:
			'Play an animation on the OpenHuman on-page avatar. This is a self-contained, terminal action: it fully satisfies a request to make the avatar perform an animation. On success the request is complete — do NOT call further tools or take additional actions unless the user explicitly asks for more. Blocks until the browser reports the result. Use list_connections first if unsure which userId is connected.',
		inputSchema: {
			animation: z
				.string()
				.describe(
					'Animation clip name to play (e.g. "WAVE", "IDLE"). Case-insensitive; resolved against the avatar\'s loaded glTF clips.'
				),
			userId: z
				.string()
				.optional()
				.describe(
					`Target browser connection id. Defaults to the default avatar connection (${DEFAULT_SOLDIER_USER_ID}).`
				),
		},
	},
	async ({ animation, userId }) => {
		try {
			const result = await hub.playAnimation(userId ?? DEFAULT_SOLDIER_USER_ID, animation)
			// Reinforce, in the payload the model actually reads, that the action is
			// finished and no follow-up is expected. The tool description alone is
			// easy for a model to overlook once it has a result in hand.
			return {
				content: [
					{
						type: 'text',
						text: `${result}\n\nAnimation complete. The request is fully satisfied; no further action is needed.`,
					},
				],
			}
		} catch (err) {
			return fail(err)
		}
	}
)

mcpServer.registerTool(
	'list_connections',
	{
		description: 'List the userIds of all currently connected OpenHuman avatars.',
	},
	async () => ok({ connections: hub.connections })
)

mcpServer.registerTool(
	'get_status',
	{
		description: 'Check the current status of the soldier hub.',
	},
	async () => ok({ connected: hub.connections.length > 0, connections: hub.connections })
)

const transport = new StdioServerTransport()
await mcpServer.connect(transport)
console.error('[soldier-mcp] MCP server ready (stdio)')
