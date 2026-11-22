/** Types of `scsProjection.worker.mjs` (development only, Phase 2.4D B1, B1.5.1). */
export declare function scsProjectionHandler(definition: string): {
  forward(position: number[]): number[]
  inverse(position: number[]): number[]
}

export declare const STATUS_MESSAGE: string
export declare const STATUS_CRS: string

/** The parts of a MapLibre worker scope the script uses. */
export interface ProjectionWorkerScope {
  setProjectionHandler?: (handler: typeof scsProjectionHandler) => void
  worker?: { actor?: ProjectionWorkerActor }
  actor?: ProjectionWorkerActor
}

export interface ProjectionWorkerActor {
  registerMessageHandler(type: string, handler: () => Promise<unknown>): void
}

export declare function installScsProjection(scope: ProjectionWorkerScope | undefined | null): {
  handler: boolean
  status: boolean
}
