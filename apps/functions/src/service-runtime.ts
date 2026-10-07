import { Firestore } from '@google-cloud/firestore';
import { DiscoveryService, PlacesServiceApi } from '@places/core';
import {
  FirestoreRepository,
  FirestoreDocuments,
  GooglePlacesPoi,
  FallbackPoi,
  NominatimPoi,
  googlePlacesAdc,
  OpenAiOAuth,
  SecretSessions,
  googleSessionSecrets,
  RefreshLease,
  OpenAiSearch,
  OpenAiVision,
  OpenAiReasoningEffortSchema,
} from '@places/providers';
import { IdSchema } from '@places/schemas';
export function createServiceRuntime(env: NodeJS.ProcessEnv) {
  const project = env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT;
  if (!project) throw new Error('service_configuration_invalid');
  const workspace = IdSchema.parse(env.WORKSPACE_ID);
  const db = new Firestore({ projectId: project });
  const repository = new FirestoreRepository(db);
  const docs = new FirestoreDocuments(db);
  const poi = new FallbackPoi(
    new GooglePlacesPoi(googlePlacesAdc(project), project),
    new NominatimPoi(docs, env.NOMINATIM_ENDPOINT || undefined),
  );
  // Grounded ID preparation does not load or call an LLM. Structured clue
  // resolution lazily reuses the same SIWC refresh lease and bounded search.
  let search: OpenAiSearch | undefined;
  const getSearch = () => {
    if (!search) {
      const model = env.OPENAI_MODEL;
      if (!model) throw new Error('service_configuration_invalid');
      const effort = OpenAiReasoningEffortSchema.parse(
        env.OPENAI_REASONING_EFFORT ?? 'low',
      );
      const oauth = new OpenAiOAuth(
        new SecretSessions(
          googleSessionSecrets(project),
          env.OPENAI_HOST_ID ?? '',
          new RefreshLease(new FirestoreDocuments(db)),
        ),
        'owner',
      );
      const vision = new OpenAiVision(oauth, model, effort);
      let ready: Promise<void> | undefined;
      search = new OpenAiSearch(
        oauth,
        model,
        effort,
        () => (ready ??= vision.validateModel()),
      );
    }
    return search;
  };
  const service = new DiscoveryService(
    repository,
    {
      name: 'server-clues',
      recognize: async () => {
        throw new Error('unexpected_vision');
      },
    },
    {
      poi,
      search: {
        verify: (r, c) => getSearch().verify(r, c),
        normalizeLocality: (c) => getSearch().normalizeLocality(c),
      },
    },
  );
  return new PlacesServiceApi(workspace, repository, service, poi);
}
