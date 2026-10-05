import {
  DiscoverySchema,
  ProviderFailureReasonSchema,
  storedCandidate,
  type DiscoveryView,
  type PlaceDisplay,
  PlaceDisplaySchema,
  VerificationSchema,
  PoiResolutionSchema,
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
  verify(
    recognition: Recognition,
    context?: GeographicContext,
  ): Promise<Verification>;
}
export interface PoiProvider {
  firstPass?(
    recognition: Recognition,
    context?: GeographicContext,
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
    const { recognition, provider } = await this.vision.recognize(
      input.images,
      workspace.areaHint,
    );
    // Persist vision before network verification so retries/city correction never repeat it.
    const discovery = await this.repository.createDiscovery(
      DiscoverySchema.parse({
        id: input.id,
        workspaceId: input.workspaceId,
        source: input.source,
        recognition,
        candidates: [],
        visionProvider: provider,
        status: 'needs_confirmation',
        revision: 0,
        createdAt: new Date().toISOString(),
      }),
    );
    return this.verification ? this.resolve(discovery) : discovery;
  }
  async resolve(discovery: Discovery): Promise<DiscoveryView> {
    if (
      !this.verification ||
      ['confirmed', 'cancelled', 'failed'].includes(discovery.status)
    )
      return discovery;
    const workspace = await this.repository.getWorkspace(discovery.workspaceId);
    if (!workspace) throw new Error('workspace_missing');
    const context: GeographicContext = {
      cityOverride: discovery.cityOverride,
      workspaceAreaHint: workspace.areaHint,
    };
    let resolution: PoiResolution;
    try {
      const adapt = (raw: unknown) => {
        const parsed = PoiResolutionSchema.safeParse(raw);
        if (!parsed.success) throw new ProviderFailure('poi_adaptation_failed');
        return parsed.data;
      };
      const first = this.verification.poi.firstPass
        ? adapt(
            await this.verification.poi.firstPass(
              discovery.recognition,
              context,
            ),
          )
        : undefined;
      if (
        first?.status === 'resolved' ||
        (first?.status === 'unresolved' && first.reason === 'no_place_evidence')
      ) {
        resolution = first;
      } else {
        const verified = VerificationSchema.parse(
          await this.verification.search.verify(discovery.recognition, context),
        );
        const enriched = adapt(
          await this.verification.poi.resolve(
            discovery.recognition,
            verified,
            context,
          ),
        );
        resolution =
          first?.status === 'city_unknown' &&
          enriched.status === 'unresolved' &&
          ['no_match', 'insufficient_evidence'].includes(enriched.reason)
            ? first
            : enriched;
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
            : [],
        status:
          resolution.status === 'resolved'
            ? 'needs_confirmation'
            : resolution.status === 'city_unknown'
              ? 'awaiting_city'
              : 'unresolved',
        resolutionReason:
          resolution.status === 'resolved' ? undefined : resolution.reason,
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
      ...(updated && resolution.status === 'resolved'
        ? { liveCandidate: resolution.candidate }
        : {}),
    };
  }
  async displayCandidate(
    discovery: DiscoveryView,
  ): Promise<PlaceDisplay | undefined> {
    if (discovery.candidates.length !== 1) return;
    if (discovery.liveCandidate) return discovery.liveCandidate;
    const candidate = discovery.candidates[0]!;
    if ('coordinates' in candidate) return candidate;
    if (!this.verification?.poi.refresh)
      throw new Error('provider_refresh_unavailable');
    try {
      const display = PlaceDisplaySchema.safeParse(
        await this.verification.poi.refresh(candidate.providerIdentity),
      );
      if (!display.success) throw new ProviderFailure('poi_adaptation_failed');
      return display.data;
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
      { status: 'awaiting_city', candidates: [] },
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
      { cityOverride: normalized, candidates: [] },
    );
    return updated ? this.resolve(updated) : undefined;
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
