import test from 'node:test';
import assert from 'node:assert/strict';
import { Firestore } from '@google-cloud/firestore';
import { createFeedRuntime } from '../apps/functions/dist/feed-runtime.js';

test('production feed read adapter preserves invalid siblings for incomplete projection but rejects identity/workspace scope mismatches', async () => {
  const original = Firestore.prototype.collection;
  const calls = [];
  let data = {
    id: 'invalid-place',
    workspaceId: 'fixture',
    status: 'confirmed',
    tags: 'invalid',
  };
  Firestore.prototype.collection = function (collection) {
    calls.push(collection);
    return {
      doc(workspace) {
        assert.equal(workspace, 'fixture');
        return {
          collection(name) {
            assert.equal(name, 'places');
            return {
              where(field, op, value) {
                assert.deepEqual(
                  [field, op, value],
                  ['status', '==', 'confirmed'],
                );
                return {
                  orderBy() {
                    return {
                      limit(bound) {
                        assert.equal(bound, 101);
                        return {
                          get: async () => ({
                            size: 1,
                            docs: [{ id: 'invalid-place', data: () => data }],
                          }),
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
  };
  try {
    const runtime = createFeedRuntime({
      GOOGLE_CLOUD_PROJECT: 'fixture-project',
      WORKSPACE_ID: 'fixture',
      PLACES_FEED_URL_TOKENS_ENABLED: 'false',
    });
    const source = await runtime.readPlaces(100);
    assert.deepEqual(source, { places: [data], truncated: false });
    const result = await runtime.projection.project(source.places);
    assert.equal(result.counts.invalidPlaces, 1);
    assert.equal(result.counts.placesProjected, 0);
    assert.equal(runtime.allowUrlToken, false);
    assert.deepEqual(
      Object.keys(runtime).sort(),
      [
        'allowUrlToken',
        'tokenDigest',
        'readPlaces',
        'projection',
        'diagnostic',
      ].sort(),
    );
    for (const mismatch of [
      { ...data, workspaceId: 'other' },
      { ...data, id: 'wrong-id' },
    ]) {
      data = mismatch;
      await assert.rejects(
        runtime.readPlaces(100),
        /^Error: feed_scope_invalid$/,
      );
    }
    assert.deepEqual(calls, ['workspaces', 'workspaces', 'workspaces']);
  } finally {
    Firestore.prototype.collection = original;
  }
});
