import { useEffect, useState } from 'react'

/** Wall-clock time in Unix milliseconds, refreshed every `intervalMs` to age live data. */
export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
