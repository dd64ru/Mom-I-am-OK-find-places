import { Firestore, FieldPath } from '@google-cloud/firestore';
import { IdSchema } from '@places/schemas';
import { ProjectionService } from '@places/core';
import {
  GooglePlacesPoi,
  GoogleSecrets,
  googlePlacesAdc,
} from '@places/providers';
import type { FeedDependencies } from './feed.js';
export function createFeedRuntime(env: NodeJS.ProcessEnv): FeedDependencies {
  const project = env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT;
  if (!project || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(project))
    throw new Error('feed_configuration_invalid');
  const workspace = IdSchema.parse(env.WORKSPACE_ID);
  const db = new Firestore({ projectId: project });
  const secrets = new GoogleSecrets(project);
  const poi = new GooglePlacesPoi(googlePlacesAdc(project), project);
  return {
    allowUrlToken: env.PLACES_FEED_URL_TOKENS_ENABLED === 'true',
    tokenDigest: () => secrets.read('PLACES_FEED_TOKEN_SHA256'),
    async readPlaces(limit) {
      const snapshot = await db
        .collection('workspaces')
        .doc(workspace)
        .collection('places')
        .where('status', '==', 'confirmed')
        .orderBy(FieldPath.documentId())
        .limit(limit + 1)
        .get();
      const places = snapshot.docs.slice(0, limit).map((doc) => {
        const place = doc.data();
        if (place.workspaceId !== workspace || place.id !== doc.id)
          throw new Error('feed_scope_invalid');
        // Shape validation belongs to projection: invalid siblings make a partial snapshot.
        // Scope mismatch remains a hard failure, never a cross-workspace projection.
        return place;
      });
      return { places, truncated: snapshot.size > limit };
    },
    projection: new ProjectionService(poi),
    diagnostic: (event) => console.info(JSON.stringify(event)),
  };
}
