import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/theme/theme.css'
import { createDefaultControlSource } from '@/backend/controlSource'
import { createDefaultMapSource } from '@/backend/mapSource'
import { createDefaultSource } from '@/backend/telemetrySource'
import { App } from './App'

const source = createDefaultSource()
const controlSource = createDefaultControlSource()
// Development only: `?syntheticMap` shows a generated test map in a plain browser.
const mapSource =
  import.meta.env.DEV && new URLSearchParams(window.location.search).has('syntheticMap')
    ? (await import('@/dev/syntheticMap')).createSyntheticMapSource()
    : createDefaultMapSource()

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')

createRoot(root).render(
  <StrictMode>
    <App source={source} controlSource={controlSource} mapSource={mapSource} />
  </StrictMode>,
)
