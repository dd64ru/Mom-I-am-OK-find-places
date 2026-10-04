import {
  DiscoverySchema,
  type Place,
  type Chain,
  type Workspace,
  type Recognition,
  type Candidate,
  type Discovery,
  type Reference,
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
  verify(recognition: Recognition, areaHint?: string): Promise<Reference[]>;
}
export interface PoiProvider {
  resolve(
    recognition: Recognition,
    evidence: readonly Reference[],
    areaHint?: string,
  ): Promise<Candidate[]>;
  branches(chain: Chain, area: string): Promise<Candidate[]>;
}
export interface PlacesRepository {
  getWorkspace(id: string): Promise<Workspace | undefined>;
  setArea(workspaceId: string, area: string): Promise<void>;
  getDiscovery(workspaceId: string, id: string): Promise<Discovery | undefined>;
  createDiscovery(discovery: Discovery): Promise<Discovery>;
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
    let candidates: Candidate[] = [];
    if (this.verification) {
      const evidence = await this.verification.search.verify(
        recognition,
        workspace.areaHint,
      );
      candidates = await this.verification.poi.resolve(
        recognition,
        evidence,
        workspace.areaHint,
      );
    }
    // Even one high-confidence provider candidate needs explicit user confirmation.
    // Confirmed Place writes are deliberately not exposed by the ingestion path.
    return this.repository.createDiscovery(
      DiscoverySchema.parse({
        id: input.id,
        workspaceId: input.workspaceId,
        source: input.source,
        recognition,
        candidates,
        visionProvider: provider,
        status: 'needs_confirmation',
        createdAt: new Date().toISOString(),
      }),
    );
  }
}
