/**
 * PROTOTYPE (M2): LRU bookkeeping of the WebGL renderer's per-tile GPU buffers. Pure: the
 * renderer passes a `release` callback that deletes the buffer and vertex arrays of an entry.
 *
 * The budget counts the bytes requested with `bufferData`, not measured video memory. Visible
 * tiles are never evicted: when they alone exceed the budget, the cache keeps them all and
 * reports `overBudget` instead of silently dropping visible geometry.
 */

export const DEFAULT_GPU_BUDGET_BYTES = 64 * 1024 * 1024

/** One buffer per package, level of detail and tile. */
export function tileKey(contentId: string, level: number, x: number, z: number): string {
  return `${contentId}/${level}/${x}/${z}`
}

export interface CacheEntry {
  key: string
  bytes: number
}

export class GpuBufferCache<E extends CacheEntry> {
  /** Map iteration order is insertion order: first = least recently used. */
  private readonly entries = new Map<string, E>()
  private readonly visible = new Set<string>()
  private total = 0

  constructor(
    readonly budgetBytes: number,
    private readonly release: (entry: E) => void,
  ) {
    if (!(budgetBytes >= 0)) throw new Error('budget must be ≥ 0')
  }

  get bytes(): number {
    return this.total
  }

  get size(): number {
    return this.entries.size
  }

  /** The visible tiles alone exceed the budget. */
  get overBudget(): boolean {
    return this.total > this.budgetBytes
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  /** Returns the entry and marks it most recently used. */
  get(key: string): E | undefined {
    const e = this.entries.get(key)
    if (e) {
      this.entries.delete(key)
      this.entries.set(key, e)
    }
    return e
  }

  /** Returns the entry without changing the LRU order. */
  peek(key: string): E | undefined {
    return this.entries.get(key)
  }

  /** Adds an entry (replacing and releasing one with the same key). Does not evict. */
  put(entry: E): void {
    const old = this.entries.get(entry.key)
    if (old) {
      this.entries.delete(entry.key)
      this.total -= old.bytes
      if (old !== entry) this.release(old)
    }
    this.entries.set(entry.key, entry)
    this.total += entry.bytes
  }

  /** The keys that must not be evicted (the tiles of the last `setTiles`). */
  setVisible(keys: Iterable<string>): void {
    this.visible.clear()
    for (const k of keys) this.visible.add(k)
  }

  isVisible(key: string): boolean {
    return this.visible.has(key)
  }

  /**
   * Evicts least recently used invisible entries until the budget holds or only visible
   * entries remain. One pass over the entries, so it always terminates.
   */
  evict(): number {
    let evicted = 0
    if (this.total <= this.budgetBytes) return 0
    for (const [key, e] of [...this.entries]) {
      if (this.total <= this.budgetBytes) break
      if (this.visible.has(key)) continue
      this.entries.delete(key)
      this.total -= e.bytes
      this.release(e)
      evicted++
    }
    return evicted
  }

  /** Releases everything (content id change, dispose). */
  clear(): void {
    const all = [...this.entries.values()]
    this.entries.clear()
    this.visible.clear()
    this.total = 0
    for (const e of all) this.release(e)
  }

  /**
   * Forgets everything without releasing (after a context loss the GL objects are already
   * gone; deleting them would only touch dead handles).
   */
  forget(): void {
    this.entries.clear()
    this.visible.clear()
    this.total = 0
  }

  values(): IterableIterator<E> {
    return this.entries.values()
  }
}
