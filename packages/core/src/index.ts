import {
  DiscoverySchema,
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
  async ingest(input: ImageSubmission): Promise<Discovery> {
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
  async resolve(discovery: Discovery): Promise<Discovery> {
    if (
      !this.verification ||
      ['confirmed', 'cancelled'].includes(discovery.status)
    )
      return discovery;
    const workspace = await this.repository.getWorkspace(discovery.workspaceId);
    if (!workspace) throw new Error('workspace_missing');
    const context: GeographicContext = {
      cityOverride: discovery.cityOverride,
      workspaceAreaHint: workspace.areaHint,
    };
    const verified = VerificationSchema.parse(
      await this.verification.search.verify(discovery.recognition, context),
    );
    const resolution = PoiResolutionSchema.parse(
      await this.verification.poi.resolve(
        discovery.recognition,
        verified,
        context,
      ),
    );
    return (
      (await this.repository.reviseDiscovery(
        discovery.workspaceId,
        discovery.id,
        discovery.revision,
        {
          candidates:
            resolution.status === 'resolved' ? [resolution.candidate] : [],
          status:
            resolution.status === 'resolved'
              ? 'needs_confirmation'
              : resolution.status === 'city_unknown'
                ? 'awaiting_city'
                : 'unresolved',
          resolutionReason:
            resolution.status === 'resolved' ? undefined : resolution.reason,
        },
      )) ??
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
  ): Promise<Discovery | undefined> {
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
