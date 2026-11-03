import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { offlineDemoSource } from '@/backend/dashboardSource'
import { App } from './App'

describe('App', () => {
  it('never shows a connected state for the offline demo source and labels demo data', () => {
    render(<App />)
    expect(screen.getByRole('status')).toHaveTextContent('ETS2 Disconnected')
    expect(screen.queryByText('ETS2 Connected')).not.toBeInTheDocument()
    expect(screen.getByText('Demo data')).toBeInTheDocument()
  })

  it('renders the dashboard cards and highlights the current page', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    for (const title of [
      'Vehicle Data',
      'Autopilot Settings',
      'Assistance Systems',
      'Route Progress',
    ]) {
      expect(screen.getByRole('region', { name: title })).toBeInTheDocument()
    }
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '48')
  })

  it('toggles a setting and persists it', () => {
    const { unmount } = render(<App />)
    const toggle = screen.getByRole('switch', { name: 'Lane Keeping' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    unmount()
    render(<App />)
    expect(screen.getByRole('switch', { name: 'Lane Keeping' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('selects a driving distance', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('radio', { name: 'Long' }))
    expect(screen.getByRole('radio', { name: 'Long' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'false')
  })

  it('marks unimplemented systems honestly', () => {
    render(<App />)
    expect(screen.getAllByText('Planned').length).toBeGreaterThanOrEqual(9)
  })

  it('shows no-data states when the source has no vehicle or job', () => {
    const empty = {
      getSnapshot: () => ({ ...offlineDemoSource.getSnapshot(), vehicle: null, job: null }),
    }
    render(<App source={empty} />)
    expect(screen.getAllByText('No data').length).toBeGreaterThan(0)
    expect(screen.getAllByText('No active job').length).toBeGreaterThan(0)
  })

  it('navigates to other sections', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))
    expect(screen.getByRole('button', { name: 'Logs' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('region', { name: 'Logs' })).toBeInTheDocument()
  })
})
