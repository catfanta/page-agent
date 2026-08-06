import { type DBSchema, type IDBPDatabase, openDB } from 'idb'

import type { RecordedStep } from './types'

const DB_NAME = 'page-agent-recorder'
const DB_VERSION = 1

export interface RecordingRecord {
	id: string
	/** User-editable display name, defaults to start URL + timestamp */
	name: string
	steps: RecordedStep[]
	/** URL where recording started */
	startUrl: string
	createdAt: number
}

interface RecorderDB extends DBSchema {
	recordings: {
		key: string
		value: RecordingRecord
		indexes: { 'by-created': number }
	}
}

let dbPromise: Promise<IDBPDatabase<RecorderDB>> | null = null

function getDB(): Promise<IDBPDatabase<RecorderDB>> {
	if (!dbPromise) {
		dbPromise = openDB<RecorderDB>(DB_NAME, DB_VERSION, {
			upgrade(db) {
				const store = db.createObjectStore('recordings', { keyPath: 'id' })
				store.createIndex('by-created', 'createdAt')
			},
		})
	}
	return dbPromise
}

export async function saveRecording(
	recording: Omit<RecordingRecord, 'id' | 'createdAt'>
): Promise<RecordingRecord> {
	const db = await getDB()
	const record: RecordingRecord = {
		...recording,
		id: crypto.randomUUID(),
		createdAt: Date.now(),
	}
	await db.put('recordings', record)
	return record
}

/** List all recordings, newest first */
export async function listRecordings(): Promise<RecordingRecord[]> {
	const db = await getDB()
	const all = await db.getAllFromIndex('recordings', 'by-created')
	return all.reverse()
}

export async function getRecording(id: string): Promise<RecordingRecord | undefined> {
	const db = await getDB()
	return db.get('recordings', id)
}

export async function updateRecording(
	id: string,
	patch: Partial<Pick<RecordingRecord, 'name' | 'steps'>>
): Promise<RecordingRecord | undefined> {
	const db = await getDB()
	const existing = await db.get('recordings', id)
	if (!existing) return undefined
	const updated = { ...existing, ...patch }
	await db.put('recordings', updated)
	return updated
}

/**
 * Delete a recording by id.
 *
 * IndexedDB's `delete` resolves successfully even when the key does not exist,
 * which hides "recording not found" behind a fake success. To keep failures
 * visible and actionable, we check existence first and throw when the id is
 * unknown. The delete and the existence check share a single readwrite
 * transaction so the result cannot race with a concurrent write.
 */
export async function deleteRecording(id: string): Promise<void> {
	const db = await getDB()
	const tx = db.transaction('recordings', 'readwrite')
	const existing = await tx.store.get(id)
	if (!existing) {
		await tx.done
		throw new Error(`Recording "${id}" not found`)
	}
	await tx.store.delete(id)
	await tx.done
}

export async function clearRecordings(): Promise<void> {
	const db = await getDB()
	await db.clear('recordings')
}
