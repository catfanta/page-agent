/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 */
import { type AgentConfig, PageAgentCore } from '@page-agent/core'
import { PageController, type PageControllerConfig } from '@page-agent/page-controller'
import { Recorder, RecordingStore, Replayer } from '@page-agent/recorder'
import { Panel, type PanelConfig } from '@page-agent/ui'

export * from '@page-agent/core'

export type PageAgentConfig = AgentConfig & PageControllerConfig & Omit<PanelConfig, 'language'>

export class PageAgent extends PageAgentCore {
	panel: Panel

	constructor(config: PageAgentConfig) {
		const pageController = new PageController({
			...config,
			enableMask: config.enableMask ?? true,
		})

		super({ ...config, pageController })

		const recorder = new Recorder(pageController)
		const replayer = new Replayer(pageController)
		const store = RecordingStore.getInstance()

		this.panel = new Panel(this, {
			language: config.language,
			promptForNextTask: config.promptForNextTask,
			recording: { recorder, replayer, store },
		})
	}
}
