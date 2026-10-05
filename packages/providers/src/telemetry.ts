import type { PoiResolution } from '@places/schemas';
const stages = [
  'image_download',
  'vision',
  'web_verification',
  'google_places',
  'nominatim',
] as const;
const statuses = [
  'ok',
  'error',
  'resolved',
  'no_match',
  'ambiguous',
  'unresolved',
  'city_unknown',
] as const;
type Stage = (typeof stages)[number];
type Status = (typeof statuses)[number];
export type PipelineEvent =
  | {
      event: 'place_pipeline_stage';
      stage: Stage;
      durationMs: number;
      status: Status;
    }
  | {
      event: 'place_resolution';
      provider: 'google-places' | 'nominatim' | 'none';
      result: PoiResolution['status'] | 'failed';
      durationMs: number;
    };
export function resolutionStatus(value: PoiResolution): Status {
  if (value.status !== 'unresolved') return value.status;
  return value.reason === 'no_match'
    ? 'no_match'
    : value.reason === 'ambiguous_poi'
      ? 'ambiguous'
      : 'unresolved';
}
export class PipelineTelemetry {
  constructor(
    private readonly emit: (event: PipelineEvent) => void = () => {},
    private readonly now = () => performance.now(),
  ) {}
  private duration(start: number) {
    const elapsed = this.now() - start;
    return Number.isFinite(elapsed)
      ? Math.max(0, Math.min(300_000, Math.round(elapsed)))
      : 0;
  }
  private log(event: PipelineEvent) {
    try {
      this.emit(event);
    } catch {
      /* Telemetry is best effort, never a processing dependency. */
    }
  }
  async measure<T>(
    stage: Stage,
    operation: () => Promise<T>,
    status: (value: T) => Status = () => 'ok',
  ): Promise<T> {
    const start = this.now();
    try {
      const value = await operation();
      const code = status(value);
      if (stages.includes(stage) && statuses.includes(code))
        this.log({
          event: 'place_pipeline_stage',
          stage,
          durationMs: this.duration(start),
          status: code,
        });
      return value;
    } catch (error) {
      if (stages.includes(stage))
        this.log({
          event: 'place_pipeline_stage',
          stage,
          durationMs: this.duration(start),
          status: 'error',
        });
      throw error;
    }
  }
  async resolve(
    operation: () => Promise<PoiResolution>,
  ): Promise<PoiResolution> {
    const start = this.now();
    let value: PoiResolution;
    try {
      value = await operation();
    } catch (error) {
      this.log({
        event: 'place_resolution',
        provider: 'none',
        result: 'failed',
        durationMs: this.duration(start),
      });
      throw error;
    }
    const identity =
      value.status === 'resolved'
        ? value.candidate.providerIdentity?.provider
        : undefined;
    const provider =
      identity === 'google-places' || identity === 'nominatim'
        ? identity
        : 'none';
    if (['resolved', 'unresolved', 'city_unknown'].includes(value.status))
      this.log({
        event: 'place_resolution',
        provider,
        result: value.status,
        durationMs: this.duration(start),
      });
    return value;
  }
}
