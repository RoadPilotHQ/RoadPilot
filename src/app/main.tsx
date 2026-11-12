import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/theme/theme.css'
import { createDefaultControlSource } from '@/backend/controlSource'
import { createDefaultSource } from '@/backend/telemetrySource'
import { App } from './App'

const source = createDefaultSource()
const controlSource = createDefaultControlSource()

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')

createRoot(root).render(
  <StrictMode>
    <App source={source} controlSource={controlSource} />
  </StrictMode>,
)
