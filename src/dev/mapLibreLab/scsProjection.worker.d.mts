/** Types of `scsProjection.worker.mjs` (development only, Phase 2.4D B1, B1.5.1, B1.5.3). */
export declare function scsProjectionHandler(definition: string): {
  forward(position: number[]): number[]
  inverse(position: number[]): number[]
}

export declare const STATUS_MESSAGE: string
export declare const STATUS_CRS: string
export declare const STATUS_SOURCE: string

/** The parts of a MapLibre worker scope the script uses. */
export interface ProjectionWorkerScope {
  setProjectionHandler?: (handler: typeof scsProjectionHandler) => void
  worker?: { actor?: ProjectionWorkerActor }
  actor?: ProjectionWorkerActor
  close?: () => void
}

export interface ProjectionWorkerActor {
  registerMessageHandler(type: string, handler: () => Promise<unknown>): void
}

export interface InstallResult {
  handler: boolean
  status: boolean
  /** The scope already had the handler; nothing was installed again. */
  duplicate: boolean
}

export declare function installScsProjection(
  scope: ProjectionWorkerScope | undefined | null,
  options?: { messagesBeforeInstall?: number },
): InstallResult

export declare class ScsWorkerBootstrapError extends Error {}

export declare function bootstrapScsWorker(
  scope: ProjectionWorkerScope | undefined | null,
  probe?: { messages: number; installed: boolean },
): InstallResult
