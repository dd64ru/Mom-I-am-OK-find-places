import { ProviderFailure, type PoiProvider } from '@places/core';
import {
  PoiResolutionSchema,
  type Recognition,
  type Verification,
  type GeographicContext,
  type PoiResolution,
} from '@places/schemas';
import { GooglePlacesFailure } from './google-places.js';
import { PipelineTelemetry, resolutionStatus } from './telemetry.js';
function adaptResolution(raw: unknown): PoiResolution {
  const parsed = PoiResolutionSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderFailure('poi_adaptation_failed');
  return parsed.data;
}
export class FallbackPoi implements PoiProvider {
  constructor(
    private readonly primary: PoiProvider,
    private readonly fallback: PoiProvider,
    private readonly telemetry = new PipelineTelemetry(),
    private readonly diagnostic: (
      code: 'google_places_fallback_used',
    ) => void = () => {},
  ) {}
  refresh(identity: { provider: string; id: string }) {
    if (!this.primary.refresh)
      throw new GooglePlacesFailure('google_places_configuration_invalid');
    return this.primary.refresh(identity);
  }
  resolve(
    recognition: Recognition,
    verification: Verification,
    context?: GeographicContext,
  ): Promise<PoiResolution> {
    return this.telemetry.resolve(async () => {
      let result: PoiResolution;
      try {
        result = await this.telemetry.measure(
          'google_places',
          async () =>
            adaptResolution(
              await this.primary.resolve(recognition, verification, context),
            ),
          resolutionStatus,
        );
      } catch (error) {
        if (
          !(error instanceof GooglePlacesFailure) ||
          error.code !== 'google_places_transient_failure'
        )
          throw error;
        this.diagnostic('google_places_fallback_used');
        return this.telemetry.measure(
          'nominatim',
          async () =>
            adaptResolution(
              await this.fallback.resolve(recognition, verification, context),
            ),
          resolutionStatus,
        );
      }
      if (
        result.status === 'resolved' ||
        [
          'locality_conflict',
          'insufficient_evidence',
          'no_place_evidence',
        ].includes(result.reason)
      )
        return result;
      const secondary = await this.telemetry.measure(
        'nominatim',
        async () =>
          adaptResolution(
            await this.fallback.resolve(recognition, verification, context),
          ),
        resolutionStatus,
      );
      // A fallback cannot downgrade known-locality Google ambiguity into a misleading city prompt/no-match.
      return secondary.status === 'resolved'
        ? secondary
        : result.reason === 'ambiguous_poi' ||
            secondary.status === 'city_unknown'
          ? result
          : secondary;
    });
  }
}
