import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import markSvg from '@/assets/brand/roadpilot-mark.svg?raw'
import iconSvg from '../../../src-tauri/roadpilot-icon.svg?raw'
import { Logo } from './Logo'

const block = (svg: string, pattern: RegExp) => svg.match(pattern)?.[0].replace(/\s+/g, ' ')

describe('Logo', () => {
  it('renders the official mark next to the wordmark', () => {
    const { container } = render(<Logo />)
    expect(screen.getByText('RoadPilot')).toHaveClass('logo-wordmark')
    const mark = container.querySelector('img.logo-mark')
    expect(mark).toHaveAttribute('src', expect.stringContaining('roadpilot-mark'))
    expect(mark).toHaveAttribute('alt', '')
  })

  it('keeps the app icon geometry identical to the central brand mark', () => {
    for (const pattern of [/<defs>[\s\S]*?<\/defs>/, /<g id="roadpilot-mark">[\s\S]*?<\/g>/]) {
      const expected = block(markSvg, pattern)
      expect(expected).toBeDefined()
      expect(block(iconSvg, pattern)).toBe(expected)
    }
  })
})
