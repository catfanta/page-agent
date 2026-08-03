import React from 'react'
import { createRoot } from 'react-dom/client'

import { OpenHumanPanel } from './OpenHumanPanel'

import './index.css'

createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<OpenHumanPanel />
	</React.StrictMode>
)
