import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  DiscoverySchema,
  FreshRecognitionSchema,
  CandidateSchema,
  storedCandidate,
  IdSchema,
  MAX_CANDIDATES,
  GooglePlaceIdSchema,
  NewSavedLabelSchema,
  SelectedLabelSchema,
  recognitionLabel,
  type PlaceDisplay,
} from '@places/schemas';
import type { Discovery, DiscoveryView } from '@places/schemas';
import {
  DiscoveryService,
  type PlacesRepository,
  type PoiProvider,
} from './index.js';
const IdentityInput = z
  .object({
    placeId: GooglePlaceIdSchema.max(512),
    // Server/application-owned or explicitly human-authored label, never provider display text.
    label: NewSavedLabelSchema.optional(),
    category: z.string().trim().min(1).max(100).optional(),
    city: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const ServiceRequestSchema = z
  .discriminatedUnion('action', [
    z
      .object({
        action: z.literal('prepare'),
        requestId: IdSchema,
        identities: z
          .array(IdentityInput)
          .min(1)
          .max(MAX_CANDIDATES)
          .optional(),
        recognition: FreshRecognitionSchema.optional(),
      })
      .strict(),
    z.object({ action: z.literal('review'), discoveryId: IdSchema }).strict(),
    z
      .object({
        action: z.literal('set_city'),
        discoveryId: IdSchema,
        revision: z.number().int().nonnegative(),
        city: z
          .string()
          .max(200)
          .refine((v) => !/\p{Cc}/u.test(v))
          .transform((v) => v.normalize('NFKC').trim().replace(/\s+/g, ' '))
          .pipe(z.string().min(1).max(200)),
      })
      .strict(),
    z
      .object({
        action: z.literal('confirm'),
        discoveryId: IdSchema,
        revision: z.number().int().nonnegative(),
        requestId: IdSchema,
        labels: z.array(SelectedLabelSchema).max(MAX_CANDIDATES).optional(),
        indices: z
          .array(
            z
              .number()
              .int()
              .min(0)
              .max(MAX_CANDIDATES - 1),
          )
          .min(1)
          .max(MAX_CANDIDATES)
          .refine((a) => new Set(a).size === a.length),
      })
      .strict(),
    z
      .object({
        action: z.literal('cancel'),
        discoveryId: IdSchema,
        revision: z.number().int().nonnegative(),
        requestId: IdSchema,
      })
      .strict(),
  ])
  .superRefine((r, ctx) => {
    if (
      r.action === 'prepare' &&
      (Boolean(r.identities) === Boolean(r.recognition) ||
        r.recognition?.mode === 'recommendation_list')
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_prepare' });
    }
  });
// Adapter independent: no Telegram identifiers, browser identities, workspace choice,
// provider display persistence, or alternate Place creation implementation.
export class PlacesServiceApi {
  constructor(
    private readonly workspace: string,
    private readonly repository: PlacesRepository,
    private readonly service: DiscoveryService,
    private readonly poi: PoiProvider,
  ) {
    IdSchema.parse(workspace);
  }
  async execute(raw: unknown) {
    const request = ServiceRequestSchema.parse(raw);
    if (request.action === 'prepare') {
      if (
        Boolean(request.identities) === Boolean(request.recognition) ||
        request.recognition?.mode === 'recommendation_list'
      )
        throw new Error('invalid_prepare');
      const id =
        'service_' +
        createHash('sha256').update(request.requestId).digest('hex');
      const digest = createHash('sha256')
        .update(JSON.stringify(request))
        .digest('hex');
      const initialViews = new Map<number, PlaceDisplay>();
      let discovery = await this.repository.getDiscovery(this.workspace, id);
      if (discovery && discovery.inputDigest !== digest)
        throw new Error('idempotency_conflict');
      if (!discovery) {
        if (!(await this.repository.getWorkspace(this.workspace)))
          throw new Error('workspace_missing');
        const recognition = request.recognition ?? {
          mode: 'recommendation_list' as const,
          visibleText: [],
          clues: request
            .identities!.filter((i) => i.label)
            .map((i) => ({
              name: i.label!,
              aliases: [],
              category: i.category ?? 'place',
              confidence: 1,
              recommendationEvidence: 'caption' as const,
              ...(i.city ? { cityHint: i.city } : {}),
            })),
        };
        // Labels need not be unique: stable provider identity remains authoritative.
        const durableRecognition = request.identities
          ? {
              ...recognition,
              mode: undefined,
              clues: recognition.clues.map(
                ({ recommendationEvidence: _, ...c }) => c,
              ),
            }
          : recognition;
        const candidates = [];
        let clueIndex = 0;
        for (const [index, identity] of (request.identities ?? []).entries()) {
          if (!this.poi.refresh)
            throw new Error('provider_refresh_unavailable');
          const view = await this.poi.refresh({
            provider: 'google-places',
            id: identity.placeId,
          });
          if (
            view.providerIdentity?.id !== identity.placeId ||
            view.providerIdentity.provider !== 'google-places'
          )
            throw new Error('provider_identity_mismatch');
          initialViews.set(index, view);
          const localityIdentity = identity.city
            ? await this.poi.resolveLocality?.(
                view.providerIdentity,
                identity.city,
              )
            : undefined;
          candidates.push(
            storedCandidate(
              CandidateSchema.parse({
                ...view,
                aliases: [],
                category: 'place',
                confidence: 1,
                resolution: 'deterministic_poi',
                // 9 is explicitly unbound in this at-most-eight-clue seed;
                // omission would trigger the legacy single-clue fallback.
                recognitionClueIndex: identity.label ? clueIndex++ : 9,
                candidateConfidence: 'low',
                relationship: 'plausible_exact',
                ...(localityIdentity ? { localityIdentity } : {}),
              }),
            ),
          );
        }
        if (
          new Set(candidates.map((c) => c.providerIdentity?.id)).size !==
          candidates.length
        )
          throw new Error('duplicate_identity');
        discovery = await this.repository.createDiscovery(
          DiscoverySchema.parse({
            id,
            workspaceId: this.workspace,
            source: {
              provider: 'ai-chat',
              externalId: request.requestId,
              observedAt: new Date().toISOString(),
            },
            recognition: durableRecognition,
            candidates,
            visionProvider: 'server-clues',
            ...(request.identities
              ? { identityProvenance: 'trusted_provider_identity' }
              : {}),
            inputDigest: digest,
            status:
              candidates.length > 1 ? 'needs_selection' : 'needs_confirmation',
            ...(candidates.length > 1 ? { selectedCandidateIndices: [] } : {}),
            revision: 0,
            createdAt: new Date().toISOString(),
          }),
        );
        if (discovery.inputDigest !== digest)
          throw new Error('idempotency_conflict');
      }
      // A retry after persisting Recognition resumes the bounded canonical resolver.
      const view =
        request.recognition && discovery.revision === 0
          ? await this.service.resolve(discovery)
          : discovery;
      return this.review(view, initialViews);
    }
    const discovery = await this.repository.getDiscovery(
      this.workspace,
      request.discoveryId,
    );
    if (!discovery || discovery.source.provider !== 'ai-chat')
      throw new Error('discovery_missing');
    if (request.action === 'review') return this.review(discovery);
    if (request.action === 'set_city') {
      if (
        discovery.revision !== request.revision ||
        discovery.status !== 'awaiting_city'
      )
        throw new Error('stale_revision');
      if (Date.now() - Date.parse(discovery.createdAt) > 24 * 60 * 60 * 1000)
        return this.review(discovery);
      const updated = await this.service.correctCity(discovery, request.city);
      if (!updated) throw new Error('stale_revision');
      return this.review(updated);
    }
    const terminal = request.action === 'confirm' ? 'confirmed' : 'cancelled';
    const indices = request.action === 'confirm' ? request.indices : [];
    const labels =
      request.action === 'confirm'
        ? [...(request.labels ?? [])].sort((a, b) => a.index - b.index)
        : [];
    if (
      new Set(labels.map((l) => l.index)).size !== labels.length ||
      labels.some((l) => !indices.includes(l.index))
    )
      throw new Error('invalid_selection');
    const sameCompletion = (d: Discovery) =>
      d.completionRequestId === request.requestId &&
      d.status === terminal &&
      d.revision === request.revision + 1 &&
      JSON.stringify(d.completionLabels ?? []) === JSON.stringify(labels) &&
      JSON.stringify(
        [...(d.selectedCandidateIndices ?? [])].sort((a, b) => a - b),
      ) === JSON.stringify([...indices].sort((a, b) => a - b));
    if (
      discovery.completionRequestId === request.requestId &&
      discovery.status === terminal
    ) {
      if (!sameCompletion(discovery)) throw new Error('idempotency_conflict');
      return this.review(discovery);
    }
    if (
      ['failed', 'expired'].includes(discovery.status) ||
      Date.now() - Date.parse(discovery.createdAt) > 24 * 60 * 60 * 1000
    )
      return this.review(discovery);
    if (
      discovery.revision !== request.revision ||
      ['confirmed', 'cancelled', 'failed'].includes(discovery.status)
    )
      throw new Error('stale_revision');
    // Provider-refresh before confirmation, identity/location never from the caller.
    if (request.action === 'confirm')
      for (const i of request.indices) {
        const candidate = discovery.candidates[i];
        if (!candidate) throw new Error('invalid_selection');
        const view = await this.service.displayCandidate(discovery, i);
        if (!view) {
          const current = await this.repository.getDiscovery(
            this.workspace,
            discovery.id,
          );
          if (current && ['failed', 'expired'].includes(current.status))
            return {
              discoveryId: current.id,
              revision: current.revision,
              status: current.status,
              candidates: [],
              confirmedPlaceIds: [],
            };
          throw new Error('provider_refresh_unavailable');
        }
      }
    const result = await this.repository.finishDiscovery(
      this.workspace,
      discovery.id,
      request.revision,
      request.action,
      {
        indices: request.action === 'confirm' ? request.indices : [],
        requestId: request.requestId,
        labels,
      },
    );
    if (!result.changed && !sameCompletion(result.discovery)) {
      if (['failed', 'expired'].includes(result.discovery.status))
        return this.review(result.discovery);
      throw new Error('stale_revision');
    }
    console.info(
      JSON.stringify({
        event: 'service_confirmation',
        selectedCount:
          request.action === 'confirm' ? request.indices.length : 0,
        newCount: result.changed
          ? (result.places?.length ?? 0) - (result.reusedCount ?? 0)
          : 0,
        reusedCount: result.reusedCount ?? 0,
      }),
    );
    return {
      ...(await this.review(result.discovery)),
      ...(result.changed
        ? {
            newCount: (result.places?.length ?? 0) - (result.reusedCount ?? 0),
            reusedCount: result.reusedCount ?? 0,
          }
        : {}),
    };
  }
  private async review(
    discovery: DiscoveryView,
    initialViews = new Map<number, PlaceDisplay>(),
  ) {
    // Persist expiration through the same revision CAS as confirmation. A stale
    // in-flight Confirm cannot finish after this terminal verdict; if Confirm won
    // the race, its completed state remains authoritative.
    if (
      !['confirmed', 'cancelled', 'failed', 'expired'].includes(
        discovery.status,
      ) &&
      Date.now() - Date.parse(discovery.createdAt) > 24 * 60 * 60 * 1000
    ) {
      const expired = await this.repository.reviseDiscovery(
        this.workspace,
        discovery.id,
        discovery.revision,
        {
          status: 'expired',
          candidates: [],
          selectedCandidateIndices: undefined,
        },
      );
      const current =
        expired ??
        (await this.repository.getDiscovery(this.workspace, discovery.id));
      if (
        !current ||
        !['confirmed', 'cancelled', 'failed', 'expired'].includes(
          current.status,
        )
      )
        throw new Error('stale_revision');
      discovery = current;
    }
    if (discovery.status === 'expired')
      return {
        discoveryId: discovery.id,
        revision: discovery.revision,
        status: discovery.status,
        candidates: [],
        confirmedPlaceIds: [],
      };
    const candidates = [];
    if (['needs_confirmation', 'needs_selection'].includes(discovery.status))
      for (let i = 0; i < discovery.candidates.length; i++) {
        const candidate = discovery.candidates[i]!;
        // Transient display may travel in this response, but the consumer persists only indices/status.
        const owned = candidate.relationship?.startsWith('related_')
          ? undefined
          : recognitionLabel(
              discovery.recognition,
              candidate.recognitionClueIndex,
            );
        const label =
          owned && NewSavedLabelSchema.safeParse(owned.label).success
            ? owned.label
            : undefined;
        // A single bound application label and previously resolved Google identity
        // suffice for verification. No cached Google display content is needed.
        const stable =
          !!label &&
          discovery.candidates.length === 1 &&
          candidate.providerIdentity?.provider === 'google-places' &&
          discovery.identityProvenance === 'trusted_provider_identity';
        const view = stable
          ? null
          : (initialViews.get(i) ??
            (await this.service.displayCandidate(discovery, i)));
        if (!stable && !view) {
          const current = await this.repository.getDiscovery(
            this.workspace,
            discovery.id,
          );
          if (current && ['failed', 'expired'].includes(current.status))
            return {
              discoveryId: current.id,
              revision: current.revision,
              status: current.status,
              candidates: [],
              confirmedPlaceIds: [],
            };
          throw new Error('provider_refresh_unavailable');
        }
        candidates.push({
          index: i,
          ...(label ? { label } : {}),
          requiresLabel: !label,
          name: stable ? label! : view!.canonicalName,
          googleMapsUrl: stable
            ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label!)}&query_place_id=${encodeURIComponent(candidate.providerIdentity!.id)}`
            : (view!.references.find((r) => r.provider === 'google-places')
                ?.url ??
              `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${view!.coordinates.latitude},${view!.coordinates.longitude}`)}`),
          attribution:
            candidate.providerIdentity?.provider === 'google-places'
              ? 'Google Maps'
              : '© OpenStreetMap contributors (ODbL)',
          confidence: candidate.candidateConfidence ?? 'low',
          relationship: candidate.relationship ?? 'plausible_exact',
        });
      }
    return {
      discoveryId: discovery.id,
      revision: discovery.revision,
      status: discovery.status,
      candidates,
      confirmedPlaceIds: discovery.confirmedPlaceIds ?? [],
      ...(discovery.completionNewCount !== undefined
        ? {
            newCount: discovery.completionNewCount,
            reusedCount: discovery.completionReusedCount ?? 0,
          }
        : {}),
    };
  }
}
