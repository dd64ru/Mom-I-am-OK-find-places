import {
  DiscoverySchema,
  FreshRecognitionSchema,
  MAX_SEARCH_BRANDS,
  ProviderFailureReasonSchema,
  storedCandidate,
  type DiscoveryView,
  type PlaceDisplay,
  PlaceDisplaySchema,
  VerificationSchema,
  PoiResolutionSchema,
  recommendationSearchCity,
  type Place,
  type Chain,
  type Workspace,
  type Recognition,
  type Discovery,
  type Reference,
  type Verification,
  type GeographicContext,
  type PoiResolution,
} from '@places/schemas';
export class ProviderFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
  terminalReason() {
    const reason = ProviderFailureReasonSchema.safeParse(this.code);
    return reason.success ? reason.data : undefined;
  }
}
export interface ImageInput {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: Uint8Array;
}
export interface VisionResult {
  provider: string;
  recognition: Recognition;
}
export interface VisionProvider {
  readonly name: string;
  recognize(
    images: readonly ImageInput[],
    areaHint?: string,
  ): Promise<VisionResult>;
}
export interface SearchProvider {
  normalizeLocality?(city: string): Promise<Verification['localityIntent']>;
  verify(
    recognition: Recognition,
    context?: GeographicContext,
  ): Promise<Verification>;
}
export interface PoiProvider {
  // A fresh, transient provider scope shares deduplication/diagnostics across phases.
  beginAttempt?(): PoiProvider;
  firstPass?(
    recognition: Recognition,
    context?: GeographicContext,
    normalization?: Verification,
  ): Promise<PoiResolution>;
  refresh?(identity: { provider: string; id: string }): Promise<PlaceDisplay>;
  resolve(
    recognition: Recognition,
    verification: Verification,
    context?: GeographicContext,
  ): Promise<PoiResolution>;
}
export interface Completion {
  discovery: Discovery;
  place?: Place;
  places?: Place[];
  reusedCount?: number;
  changed: boolean;
}
export interface PlacesRepository {
  getWorkspace(id: string): Promise<Workspace | undefined>;
  initWorkspace(workspace: Workspace): Promise<Workspace>;
  setArea(workspaceId: string, area: string): Promise<void>;
  getDiscovery(workspaceId: string, id: string): Promise<Discovery | undefined>;
  createDiscovery(discovery: Discovery): Promise<Discovery>;
  reviseDiscovery(
    workspaceId: string,
    id: string,
    revision: number,
    patch: Partial<Discovery>,
  ): Promise<Discovery | undefined>;
  finishDiscovery(
    workspaceId: string,
    id: string,
    revision: number,
    action: 'confirm' | 'cancel',
  ): Promise<Completion>;
  savePlace(place: Place): Promise<void>;
  getPlace(workspaceId: string, id: string): Promise<Place | undefined>;
  saveChain(workspaceId: string, chain: Chain): Promise<void>;
  getChain(workspaceId: string, id: string): Promise<Chain | undefined>;
}
export interface ImageSubmission {
  id: string;
  workspaceId: string;
  images: readonly ImageInput[];
  source: Reference;
}
export class DiscoveryService {
  constructor(
    private readonly repository: PlacesRepository,
    private readonly vision: VisionProvider,
    private readonly verification?: {
      search: SearchProvider;
      poi: PoiProvider;
    },
  ) {}
  async ingest(input: ImageSubmission): Promise<DiscoveryView> {
    const previous = await this.repository.getDiscovery(
      input.workspaceId,
      input.id,
    );
    if (previous) return previous;
    const workspace = await this.repository.getWorkspace(input.workspaceId);
    if (!workspace) throw new Error('workspace_missing');
    if (!input.images.length || input.images.length > 10)
      throw new Error('invalid_image_count');
    const { recognition: rawRecognition, provider } =
      await this.vision.recognize(input.images, workspace.areaHint);
    const recognition = FreshRecognitionSchema.parse(rawRecognition);
    // Persist vision before network verification so retries/city correction never repeat it.
    const discovery = await this.repository.createDiscovery(
      DiscoverySchema.parse({
        id: input.id,
        workspaceId: input.workspaceId,
        source: input.source,
        recognition,
        candidates: [],
        visionProvider: provider,
        status:
          recognition.mode === 'recommendation_list'
            ? 'awaiting_brands'
            : 'needs_confirmation',
        ...(recognition.mode === 'recommendation_list'
          ? { selectedBrandIndices: [] }
          : {}),
        revision: 0,
        createdAt: new Date().toISOString(),
      }),
    );
    this.diagnostic({
      event: 'recognition_mode',
      mode: recognition.mode ?? 'single_venue',
      identities: recognition.clues.length,
    });
    return this.verification && discovery.status !== 'awaiting_brands'
      ? this.resolve(discovery)
      : discovery;
  }
  async resolve(discovery: Discovery): Promise<DiscoveryView> {
    if (
      !this.verification ||
      ['confirmed', 'cancelled', 'failed', 'awaiting_brands'].includes(
        discovery.status,
      )
    )
      return discovery;
    const workspace = await this.repository.getWorkspace(discovery.workspaceId);
    if (!workspace) throw new Error('workspace_missing');
    const inferredCity = discovery.cityOverride
      ? undefined
      : recommendationSearchCity(
          discovery.recognition,
          discovery.selectedBrandIndices,
        );
    const context: GeographicContext = {
      cityOverride: discovery.cityOverride,
      ...(inferredCity ? { inferredCity } : {}),
      workspaceAreaHint: workspace.areaHint,
      ...(discovery.selectedBrandIndices
        ? { selectedBrandIndices: discovery.selectedBrandIndices }
        : {}),
      ...(discovery.relatedRequested ? { relatedRequested: true } : {}),
    };
    const poi = this.verification.poi.beginAttempt?.() ?? this.verification.poi;
    let resolution: PoiResolution;
    try {
      const adapt = (raw: unknown) => {
        const parsed = PoiResolutionSchema.safeParse(raw);
        if (!parsed.success) throw new ProviderFailure('poi_adaptation_failed');
        return parsed.data;
      };
      let intent: Verification['localityIntent'];
      // The user's city wins; otherwise the recommendation list's inferred city.
      const searchCity = context.cityOverride ?? context.inferredCity;
      if (searchCity && this.verification.search.normalizeLocality) {
        let outcome: 'ok' | 'unavailable' | 'invalid' = 'unavailable';
        try {
          const raw =
            await this.verification.search.normalizeLocality(searchCity);
          if (raw !== undefined) {
            const parsed =
              VerificationSchema.shape.localityIntent.safeParse(raw);
            if (
              parsed.success &&
              parsed.data &&
              parsed.data.input === searchCity
            ) {
              if (parsed.data.confidence >= 0.9) {
                intent = parsed.data;
                outcome = 'ok';
              }
            } else outcome = 'invalid';
          }
        } catch {
          // Auxiliary linguistic enrichment must never block deterministic search.
        }
        try {
          console.info(
            JSON.stringify({ event: 'locality_normalization', outcome }),
          );
        } catch {
          /* best effort */
        }
      }
      const normalization: Verification = {
        status: 'no_evidence',
        candidates: [],
        references: [],
        ...(intent ? { localityIntent: intent } : {}),
      };
      const first = poi.firstPass
        ? adapt(
            await poi.firstPass(discovery.recognition, context, normalization),
          )
        : undefined;
      if (
        (discovery.recognition.mode === 'recommendation_list' &&
          first !== undefined) ||
        first?.status === 'resolved' ||
        (first?.status === 'unresolved' && first.reason === 'no_place_evidence')
      ) {
        resolution = first;
      } else {
        const reviewable =
          first?.status === 'alternatives' || first?.status === 'city_unknown'
            ? first
            : undefined;
        const degraded = (
          reason: 'verification_failed' | 'verification_unavailable',
        ) => {
          try {
            console.info(
              JSON.stringify({
                event: 'optional_web_enrichment',
                outcome: 'degraded',
                reason,
                result: reviewable!.status,
              }),
            );
          } catch {
            /* best effort */
          }
        };
        let raw: Verification | undefined;
        let failed = false;
        // Only the optional web call is recoverable. Schema adaptation and Google
        // failures below keep their existing fail-closed/retry behavior.
        try {
          raw = await this.verification.search.verify(
            discovery.recognition,
            context,
          );
        } catch (error) {
          if (!reviewable) throw error;
          failed = true;
          degraded('verification_failed');
        }
        if (failed) resolution = reviewable!;
        else {
          const parsed = VerificationSchema.parse(raw);
          if (reviewable && parsed.status === 'unavailable') {
            degraded('verification_unavailable');
            resolution = reviewable;
          } else {
            let verified = parsed;
            if (!verified.localityIntent && intent)
              verified = { ...verified, localityIntent: intent };
            const enriched = adapt(
              await poi.resolve(discovery.recognition, verified, context),
            );
            resolution =
              first?.status === 'alternatives' &&
              enriched.status === 'unresolved' &&
              [
                'no_match',
                'insufficient_evidence',
                'no_place_evidence',
              ].includes(enriched.reason)
                ? first
                : first?.status === 'city_unknown' &&
                    enriched.status === 'unresolved' &&
                    ['no_match', 'insufficient_evidence'].includes(
                      enriched.reason,
                    )
                  ? first
                  : enriched;
          }
        }
      }
    } catch (error) {
      return this.recordFailure(discovery, error);
    }

    const updated = await this.repository.reviseDiscovery(
      discovery.workspaceId,
      discovery.id,
      discovery.revision,
      {
        candidates:
          resolution.status === 'resolved'
            ? [storedCandidate(resolution.candidate)]
            : resolution.status === 'alternatives'
              ? resolution.candidates.map(storedCandidate)
              : [],
        status:
          resolution.status === 'resolved'
            ? 'needs_confirmation'
            : resolution.status === 'alternatives'
              ? 'needs_selection'
              : resolution.status === 'city_unknown'
                ? 'awaiting_city'
                : 'unresolved',
        selectedCandidateIndices:
          resolution.status === 'alternatives' ? [] : undefined,
        resolutionReason:
          resolution.status === 'resolved' ||
          resolution.status === 'alternatives'
            ? undefined
            : resolution.reason,
      },
    );
    const next =
      updated ??
      (await this.repository.getDiscovery(
        discovery.workspaceId,
        discovery.id,
      ))!;
    return {
      ...next,
      ...(updated && resolution.status === 'alternatives'
        ? { liveAlternatives: resolution.candidates }
        : {}),
      ...(updated && resolution.status === 'resolved'
        ? { liveCandidate: resolution.candidate }
        : {}),
    };
  }
  async displayCandidate(
    discovery: DiscoveryView,
    index = 0,
  ): Promise<PlaceDisplay | undefined> {
    if (
      discovery.status !== 'needs_selection' &&
      discovery.candidates.length !== 1
    )
      return;
    if (discovery.liveAlternatives?.[index])
      return discovery.liveAlternatives[index];
    if (discovery.liveCandidate) return discovery.liveCandidate;
    const candidate = discovery.candidates[index];
    if (!candidate) return;
    if ('coordinates' in candidate) return candidate;
    if (!this.verification?.poi.refresh)
      throw new Error('provider_refresh_unavailable');
    try {
      const display = PlaceDisplaySchema.safeParse(
        await this.verification.poi.refresh(candidate.providerIdentity),
      );
      if (!display.success) throw new ProviderFailure('poi_adaptation_failed');
      return {
        ...display.data,
        candidateConfidence: candidate.candidateConfidence,
        relationship: candidate.relationship,
      };
    } catch (error) {
      await this.recordFailure(discovery, error);
      return;
    }
  }
  private async recordFailure(
    discovery: Discovery,
    error: unknown,
  ): Promise<Discovery> {
    const reason =
      error instanceof ProviderFailure ? error.terminalReason() : undefined;
    if (!reason) throw error;
    const failed = await this.repository.reviseDiscovery(
      discovery.workspaceId,
      discovery.id,
      discovery.revision,
      { status: 'failed', failureReason: reason, candidates: [] },
    );
    if (failed)
      console.error(
        JSON.stringify({ event: 'provider_terminal_failure', reason }),
      );
    return (
      failed ??
      (await this.repository.getDiscovery(discovery.workspaceId, discovery.id))!
    );
  }
  async requestCity(discovery: Discovery): Promise<Discovery | undefined> {
    return this.repository.reviseDiscovery(
      discovery.workspaceId,
      discovery.id,
      discovery.revision,
      {
        status: 'awaiting_city',
        candidates: [],
        selectedCandidateIndices: undefined,
      },
    );
  }
  async correctCity(
    discovery: Discovery,
    city: string,
  ): Promise<DiscoveryView | undefined> {
    const normalized = normalizeCity(city);
    if (!normalized || discovery.status !== 'awaiting_city') return;
    const updated = await this.repository.reviseDiscovery(
      discovery.workspaceId,
      discovery.id,
      discovery.revision,
      {
        cityOverride: normalized,
        candidates: [],
        selectedCandidateIndices: undefined,
      },
    );
    return updated ? this.resolve(updated) : undefined;
  }
  private diagnostic(event: object) {
    try {
      console.info(JSON.stringify(event));
    } catch {
      /* best effort */
    }
  }
  async updateBrandSelection(
    discovery: Discovery,
    action: 'toggle' | 'all' | 'clear',
    index?: number,
  ) {
    if (discovery.status !== 'awaiting_brands') return;
    const selected = new Set(discovery.selectedBrandIndices ?? []);
    if (action === 'all') {
      // Never implicitly choose a subset of an oversized list.
      if (discovery.recognition.clues.length > MAX_SEARCH_BRANDS) return;
      discovery.recognition.clues.forEach((_, i) => selected.add(i));
    } else if (action === 'clear') selected.clear();
    else {
      if (
        index === undefined ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= discovery.recognition.clues.length
      )
        return;
      if (selected.has(index)) selected.delete(index);
      else if (selected.size < MAX_SEARCH_BRANDS) selected.add(index);
      else return;
    }
    return this.repository.reviseDiscovery(
      discovery.workspaceId,
      discovery.id,
      discovery.revision,
      { selectedBrandIndices: [...selected].sort((a, b) => a - b) },
    );
  }
  async searchBrands(discovery: Discovery): Promise<DiscoveryView | undefined> {
    if (
      discovery.status !== 'awaiting_brands' ||
      !discovery.selectedBrandIndices?.length
    )
      return;
    this.diagnostic({
      event: 'recommendation_selection',
      selectedCount: discovery.selectedBrandIndices.length,
    });
    // A typed city first, then a safe cityHint shared by every selected clue; else ask.
    const city =
      discovery.cityOverride ??
      recommendationSearchCity(
        discovery.recognition,
        discovery.selectedBrandIndices,
      );
    const updated = await this.repository.reviseDiscovery(
      discovery.workspaceId,
      discovery.id,
      discovery.revision,
      { status: city ? 'needs_confirmation' : 'awaiting_city' },
    );
    return updated && city ? this.resolve(updated) : updated;
  }
  async requestBrands(discovery: Discovery) {
    if (discovery.recognition.mode !== 'recommendation_list') return;
    return this.repository.reviseDiscovery(
      discovery.workspaceId,
      discovery.id,
      discovery.revision,
      {
        status: 'awaiting_brands',
        candidates: [],
        selectedCandidateIndices: undefined,
      },
    );
  }
  async requestRelated(
    discovery: Discovery,
  ): Promise<DiscoveryView | undefined> {
    if (
      discovery.recognition.mode === 'recommendation_list' ||
      discovery.relatedRequested ||
      discovery.candidates.length !== 1 ||
      discovery.candidates[0]?.providerIdentity?.provider !== 'google-places' ||
      discovery.status !== 'needs_confirmation'
    )
      return;
    this.diagnostic({
      event: 'optional_related_discovery',
      outcome: 'requested',
    });
    const updated = await this.repository.reviseDiscovery(
      discovery.workspaceId,
      discovery.id,
      discovery.revision,
      { relatedRequested: true, selectedCandidateIndices: undefined },
    );
    return updated ? this.resolve(updated) : undefined;
  }
  async updateSelection(
    discovery: Discovery,
    action: 'toggle' | 'all' | 'clear',
    index?: number,
  ): Promise<Discovery | undefined> {
    if (discovery.status !== 'needs_selection') return;
    const selected = new Set(discovery.selectedCandidateIndices ?? []);
    if (action === 'all')
      discovery.candidates.forEach((_, i) => selected.add(i));
    else if (action === 'clear') selected.clear();
    else {
      if (
        index === undefined ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= discovery.candidates.length
      )
        return;
      if (selected.has(index)) selected.delete(index);
      else selected.add(index);
    }
    return this.repository.reviseDiscovery(
      discovery.workspaceId,
      discovery.id,
      discovery.revision,
      {
        selectedCandidateIndices: [...selected].sort((a, b) => a - b),
      },
    );
  }
  // Compatibility port: selecting a checkbox never collapses candidates.
  selectAlternative(discovery: Discovery, index: number) {
    return this.updateSelection(discovery, 'toggle', index);
  }
  finish(discovery: Discovery, action: 'confirm' | 'cancel') {
    return this.repository.finishDiscovery(
      discovery.workspaceId,
      discovery.id,
      discovery.revision,
      action,
    );
  }
}
export function normalizeCity(value: string): string | undefined {
  if (value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) return;
  const city = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return city && city.length <= 200 ? city : undefined;
}
export * from './projection.js';
export * from './label-backfill.js';
