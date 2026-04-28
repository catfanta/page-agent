import React from 'react'
import { createRoot } from 'react-dom/client'

import { HermesPanel } from './HermesPanel'

import './index.css'

createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<HermesPanel />
	</React.StrictMode>
)
