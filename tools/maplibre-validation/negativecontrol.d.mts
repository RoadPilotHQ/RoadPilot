/** Types of `negativecontrol.mjs` (B1.5.4G, for the unit tests in src/dev/mapLibreLab/tests). */
export declare const NEGATIVE_CONTROL_FLAG: '--negative-control'
export declare const CONTROL_MODE: 'control'
export declare const CONTROL_KIND: 'negative-control'
export declare const CONTROL_HOLD_MS: number
export declare function controlSessionName(stamp: string): string
export declare function validateRunArgs(
  mode: string | undefined,
  args: string[],
): { ok: true; negativeControl: boolean } | { ok: false; error: string }
