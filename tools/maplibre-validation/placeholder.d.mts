/** Types of `placeholder.mjs` (B1.5.4E, for the unit tests in src/dev/mapLibreLab/tests). */
export declare const PLACEHOLDER_META: string
export declare const PLACEHOLDER_MARKER: string
export declare const PLACEHOLDER_ICON: string
export declare const PLACEHOLDER_HTML: string
export declare const APP_DOCUMENT_PATHS: readonly string[]

export interface PlaceholderRequest {
  method?: string
  url?: string
}

export interface PlaceholderResponse {
  statusCode: number
  setHeader(name: string, value: string): unknown
  end(body?: string): unknown
}

export interface PlaceholderSwitch {
  isActive(): boolean
  middleware(req: PlaceholderRequest, res: PlaceholderResponse, next: () => void): void
  handleMessage(
    message: unknown,
    context: { listening: boolean; pid: number; send(message: Record<string, unknown>): void },
  ): boolean
}

export declare function createPlaceholderSwitch(): PlaceholderSwitch
