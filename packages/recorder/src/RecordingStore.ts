import type { Recording } from './types'

const DB_NAME = 'page-agent-recordings'
const STORE_NAME = 'recordings'
const DB_VERSION = 1

/**
 * IndexedDB-backed store for recordings.
 * Singleton: use RecordingStore.getInstance().
 */
export class RecordingStore {
	private static instance: RecordingStore | null = null
	private dbPromise: Promise<IDBDatabase> | null = null

	private constructor() {}

	static getInstance(): RecordingStore {
		if (!RecordingStore.instance) {
			RecordingStore.instance = new RecordingStore()
		}
		return RecordingStore.instance
	}

	private getDb(): Promise<IDBDatabase> {
		if (this.dbPromise) return this.dbPromise
		this.dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, DB_VERSION)
			req.onupgradeneeded = (e) => {
				const db = (e.target as IDBOpenDBRequest).result
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
					store.createIndex('createdAt', 'createdAt', { unique: false })
				}
			}
			req.onsuccess = (e) => {
				resolve((e.target as IDBOpenDBRequest).result)
			}
			req.onerror = () => reject(req.error)
			req.onblocked = () => reject(new Error('IDB open blocked by another tab'))
		})
		return this.dbPromise
	}

	async save(recording: Recording): Promise<void> {
		const db = await this.getDb()
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite')
			tx.objectStore(STORE_NAME).put(recording)
			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
		})
	}

	/** Returns all recordings sorted by createdAt descending (newest first). */
	async list(): Promise<Recording[]> {
		const db = await this.getDb()
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readonly')
			const req = tx.objectStore(STORE_NAME).index('createdAt').getAll()
			req.onsuccess = () => resolve((req.result as Recording[]).reverse())
			req.onerror = () => reject(req.error)
		})
	}

	async get(id: string): Promise<Recording | undefined> {
		const db = await this.getDb()
		return new Promise((resolve, reject) => {
			const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
			req.onsuccess = () => resolve(req.result as Recording | undefined)
			req.onerror = () => reject(req.error)
		})
	}

	async delete(id: string): Promise<void> {
		const db = await this.getDb()
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite')
			tx.objectStore(STORE_NAME).delete(id)
			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
		})
	}

	async rename(id: string, name: string): Promise<void> {
		const recording = await this.get(id)
		if (!recording) throw new Error(`Recording "${id}" not found`)
		await this.save({ ...recording, name })
	}
}
