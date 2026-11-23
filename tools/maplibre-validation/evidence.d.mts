/** Types of `evidence.mjs` (B1.5.4B, for the unit tests in src/dev/mapLibreLab/tests). */
export declare const CAPTURE_TIMEOUT_MS: number

export interface ShotParts {
  test: string
  seq: number
  scenario: string
  view: string
  adapter: string
}

export interface ShotRecord {
  seq: number
  name: string | null
  scenario: string
  view: string
  status: 'saved' | 'failed'
  stage: 'name' | 'capture' | 'write' | null
  error: string | null
  bytes?: number
}

export interface WrittenFile {
  length: number
}

export declare function screenshotName(parts: ShotParts): string

export declare function createScreenshotRecorder<Png extends WrittenFile>(options: {
  test: string
  adapter: string
  exists(name: string): boolean
  write(name: string, png: Png): void
  decode(base64: string): Png
  timeoutMs?: number
}): {
  capture(
    what: { scenario: string; view: string },
    grab: () => Promise<string | undefined> | string | undefined,
  ): Promise<ShotRecord>
  records(): ShotRecord[]
}
