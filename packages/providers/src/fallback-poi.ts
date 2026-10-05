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
  beginAttempt(): PoiProvider {
    return new FallbackPoi(
      this.primary.beginAttempt?.() ?? this.primary,
      this.fallback,
      this.telemetry,
      this.diagnostic,
    );
  }
  refresh(identity: { provider: string; id: string }) {
    if (!this.primary.refresh)
      throw new GooglePlacesFailure('google_places_configuration_invalid');
    return this.primary.refresh(identity);
  }
  firstPass(
    recognition: Recognition,
    context?: GeographicContext,
  ): Promise<PoiResolution> {
    // First-pass ambiguity gets enrichment before ordinary no-match OSM fallback.
    return this.telemetry.resolve(async () => {
      try {
        return adaptResolution(
          await (this.primary.firstPass
            ? this.primary.firstPass(recognition, context)
            : this.primary.resolve(
                recognition,
                { status: 'no_evidence', candidates: [], references: [] },
                context,
              )),
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
              await this.fallback.resolve(
                recognition,
                { status: 'no_evidence', candidates: [], references: [] },
                context,
              ),
            ),
          resolutionStatus,
        );
      }
    });
  }
  resolve(
    recognition: Recognition,
    verification: Verification,
    context?: GeographicContext,
  ): Promise<PoiResolution> {
    return this.telemetry.resolve(async () => {
      let result: PoiResolution;
      try {
        result = adaptResolution(
          await this.primary.resolve(recognition, verification, context),
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
        result.status === 'alternatives' ||
        ['locality_conflict', 'no_place_evidence'].includes(result.reason)
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
            result.reason === 'insufficient_evidence' ||
            secondary.status === 'city_unknown'
          ? result
          : secondary;
    });
  }
}
