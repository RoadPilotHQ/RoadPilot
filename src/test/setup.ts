import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom implements no canvas. Drawing is tested with a fake context
// (src/ui/navigation/pathView.test.ts); components must cope with a missing context.
HTMLCanvasElement.prototype.getContext = (() => null) as never

afterEach(() => {
  cleanup()
  localStorage.clear()
})
