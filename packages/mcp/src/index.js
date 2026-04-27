#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { exec } from 'node:child_process'
import { platform } from 'node:os'
import * as z from 'zod/v4'

import { HubBridge } from './hub-bridge.js'

/** @param {unknown} data */
function ok(data) {
	return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}
/** @param {Error} err */
function fail(err) {
	return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
}

const env = process.env
const port = parseInt(env.PORT || '38401')

/** @type {Record<string, string>} */
const llmConfig = {}
if (env.LLM_BASE_URL) llmConfig.baseURL = env.LLM_BASE_URL
if (env.LLM_MODEL_NAME) llmConfig.model = env.LLM_MODEL_NAME
if (env.LLM_API_KEY) llmConfig.apiKey = env.LLM_API_KEY

// --- Hub bridge (HTTP + WebSocket) ---

const hub = new HubBridge(port)
await hub.start()

// Open launcher in default browser
const url = `http://localhost:${port}`
const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start ""' : 'xdg-open'
exec(`${cmd} "${url}"`, (err) => {
	if (err) console.error(`[page-agent-mcp] Could not open browser: ${err.message}`)
})

// --- MCP server (stdio) ---

const mcpServer = new McpServer({ name: 'page-agent', version: '1.5.8' })

mcpServer.registerTool(
	'execute_task',
	{
		description: "Execute a task in user's browser.",
		inputSchema: {
			task: z
				.string()
				.describe(
					'Task description. Give specific instructions for the task. Steps preferable. And the information you want to get after the task is done.'
				),
		},
	},
	async ({ task }) => {
		try {
			const config = Object.keys(llmConfig).length > 0 ? llmConfig : undefined
			const result = await hub.executeTask(task, config)
			return {
				content: [
					{
						type: 'text',
						text: result.success
							? `Task completed.\n\n${result.data}`
							: `Task failed.\n\n${result.data}`,
					},
				],
			}
		} catch (err) {
			return fail(err)
		}
	}
)

mcpServer.registerTool(
	'get_status',
	{
		description: 'Check the current status of the Page Agent hub.',
	},
	async () => ({
		content: [
			{
				type: 'text',
				text: JSON.stringify({ connected: hub.connected, busy: hub.busy }, null, 2),
			},
		],
	})
)

mcpServer.registerTool(
	'stop_task',
	{
		description: 'Stop the currently running browser automation task.',
	},
	async () => {
		hub.stopTask()
		return { content: [{ type: 'text', text: 'Stop signal sent.' }] }
	}
)

// --- Recorder tools ---

mcpServer.registerTool(
	'recorder_start',
	{
		description:
			'Start recording user interactions in the active browser tab. Returns the tab ID and starting URL. Only one recording can be active at a time; calling this again replaces any previous recording.',
	},
	async () => {
		try {
			return ok(await hub.recorderStart())
		} catch (err) {
			return fail(err)
		}
	}
)

mcpServer.registerTool(
	'recorder_stop',
	{
		description:
			'Stop the current recording and return all captured steps. Optionally provide a name to save it to IndexedDB automatically.',
		inputSchema: {
			name: z
				.string()
				.optional()
				.describe(
					'If provided, saves the recording under this name and returns { recording, stepsCount }. If omitted, returns { steps, startUrl, stepsCount }.'
				),
		},
	},
	async ({ name }) => {
		try {
			return ok(await hub.recorderStop(name))
		} catch (err) {
			return fail(err)
		}
	}
)

mcpServer.registerTool(
	'replay_start',
	{
		description:
			'Replay a saved recording in the active browser tab. Blocks until all steps complete. Provide either recordingId (loads from IndexedDB) or inline steps array.',
		inputSchema: {
			recordingId: z
				.string()
				.optional()
				.describe('ID of a saved recording to load from IndexedDB.'),
			steps: z
				.array(z.unknown())
				.optional()
				.describe('Inline steps array from a previous recorder_stop call.'),
		},
	},
	async ({ recordingId, steps }) => {
		try {
			return ok(await hub.sendCommand('replay_start', recordingId ? { recordingId } : { steps }))
		} catch (err) {
			return fail(err)
		}
	}
)

mcpServer.registerTool(
	'replay_stop',
	{
		description: 'Abort the currently running replay.',
	},
	async () => {
		try {
			return ok(await hub.replayStop())
		} catch (err) {
			return fail(err)
		}
	}
)

// --- Recordings storage tools ---

mcpServer.registerTool(
	'recordings_list',
	{
		description:
			'List all saved recordings in the extension IndexedDB, newest first. Returns id, name, startUrl, createdAt, stepsCount for each.',
	},
	async () => {
		try {
			return ok(await hub.recordingsList())
		} catch (err) {
			return fail(err)
		}
	}
)

mcpServer.registerTool(
	'recordings_get',
	{
		description: 'Get a saved recording by ID, including its full steps array.',
		inputSchema: {
			id: z.string().describe('Recording ID returned by recordings_list or recorder_stop.'),
		},
	},
	async ({ id }) => {
		try {
			return ok(await hub.recordingsGet(id))
		} catch (err) {
			return fail(err)
		}
	}
)

mcpServer.registerTool(
	'recordings_delete',
	{
		description: 'Delete a saved recording from IndexedDB.',
		inputSchema: {
			id: z.string().describe('Recording ID to delete.'),
		},
	},
	async ({ id }) => {
		try {
			return ok(await hub.recordingsDelete(id))
		} catch (err) {
			return fail(err)
		}
	}
)

mcpServer.registerTool(
	'recordings_save',
	{
		description:
			'Save a steps array as a named recording in IndexedDB. Use this after recorder_stop when you did not pass a name.',
		inputSchema: {
			name: z.string().describe('Display name for the recording.'),
			steps: z.array(z.unknown()).describe('Steps array from recorder_stop.'),
			startUrl: z.string().optional().describe('Starting URL of the recording.'),
		},
	},
	async ({ name, steps, startUrl }) => {
		try {
			return ok(await hub.recordingsSave(name, steps, startUrl ?? ''))
		} catch (err) {
			return fail(err)
		}
	}
)

const transport = new StdioServerTransport()
await mcpServer.connect(transport)
console.error('[page-agent-mcp] MCP server ready (stdio)')
