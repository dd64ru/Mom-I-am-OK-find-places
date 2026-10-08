import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryService, ProjectionService } from '@places/core';
import { FirestoreRepository, canonicalPlaceId } from '@places/providers';
import { candidateRecognitionLabel, recognitionLabel } from '@places/schemas';
import { TelegramInteractions } from '../apps/functions/dist/interactions.js';
import { MemoryDb } from './fixtures/memory-db.mjs';
const time = '2026-10-08T00:00:00.000Z';
const recognition = {
  mode: 'single_venue',
  visibleText: ['春雨饺子'],
  clues: [
    {
      name: 'Spring Rain Dumplings',
      nativeName: '春雨饺子',
      possibleChain: 'Spring Rain Dumplings',
      aliases: [],
      category: 'restaurant',
      confidence: 0.95,
    },
  ],
};
function candidate(i) {
  return {
    resolution: 'deterministic_poi',
    recognitionClueIndex: 0,
    relationship: i ? 'related_chain_location' : 'likely_exact',
    providerIdentity: { provider: 'google-places', id: `branch-${i}` },
    references: [
      {
        provider: 'google-places',
        externalId: `branch-${i}`,
        observedAt: time,
      },
    ],
  };
}
const candidates = Array.from({ length: 7 }, (_, i) => candidate(i));
async function fixture(clues = recognition) {
  const db = new MemoryDb(),
    repo = new FirestoreRepository(db);
  await repo.initWorkspace({
    id: 'shared',
    members: [],
    settings: { locale: 'ru' },
    createdAt: time,
    updatedAt: time,
  });
  const hydrator = {
    refresh: async (identity) => ({
      providerIdentity: identity,
      canonicalName: 'PROHIBITED_GOOGLE_DISPLAY',
      coordinates: {
        latitude: 1 + Number(identity.id.split('-').at(-1)) / 100,
        longitude: 2,
        crs: 'WGS84',
      },
      address: { formatted: 'PROHIBITED_GOOGLE_ADDRESS' },
      references: [
        {
          provider: 'google-places',
          externalId: identity.id,
          observedAt: time,
        },
      ],
    }),
  };
  const service = new DiscoveryService(
    repo,
    { name: 'fixture', recognize: async () => assert.fail('no vision call') },
    { poi: hydrator },
  );
  const discovery = await repo.createDiscovery({
    id: 'seven',
    workspaceId: 'shared',
    source: { provider: 'telegram', observedAt: time },
    recognition: clues,
    candidates,
    visionProvider: 'fixture',
    status: 'needs_selection',
    revision: 1,
    createdAt: time,
    updatedAt: time,
  });
  const states = new Map(),
    sent = [];
  let nextId = 100;
  const telegram = new TelegramInteractions(
    {
      change: async (path, fn) => {
        const { value, result } = fn(states.get(path));
        if (value !== undefined) states.set(path, structuredClone(value));
        return result;
      },
    },
    repo,
    service,
    {
      call: async (method, body) => {
        const message_id = ++nextId;
        sent.push({ method, body, message_id });
        return { message_id };
      },
    },
    'shared',
    -100,
  );
  function callback(action, index = 0) {
    const codes = { select: 's', confirm: 'c', all: 'a' };
    const m = sent.findLast((m) =>
      m.body.reply_markup?.inline_keyboard
        ?.flat()
        .some((b) => b.callback_data?.split(':')[2] === codes[action]),
    );
    assert.ok(m, `button ${action} exists`);
    const button = m.body.reply_markup.inline_keyboard
      .flat()
      .find(
        (b) =>
          b.callback_data?.split(':')[2] === codes[action] &&
          (action !== 'select' ||
            Number(b.callback_data.split(':')[3]) === index),
      );
    assert.ok(button);
    return {
      kind: 'callback',
      callbackId: `callback-${action}-${index}`,
      token: button.callback_data.split(':')[1],
      action,
      ...(action === 'select' ? { index } : {}),
      messageId: m.body.message_id ?? m.message_id,
      userId: 11,
    };
  }
  return { db, repo, hydrator, service, discovery, telegram, sent, callback };
}
const saved = (db) =>
  [...db.values.entries()]
    .filter(([p]) => p.includes('/places/'))
    .map(([, v]) => v);
test('Telegram selects seven Chinese dumpling branches, confirms once, and projects seven independent positions with the same evidenced native brand', async () => {
  const f = await fixture();
  await f.telegram.propose(f.discovery, 11, 1);
  // Actual Telegram selection handlers update server-owned indices; no saving until Confirm.
  await f.telegram.callback(f.callback('all'));
  assert.equal(saved(f.db).length, 0);
  const confirm = f.callback('confirm');
  await f.telegram.callback(confirm);
  await f.telegram.callback(confirm);
  const d = await f.repo.getDiscovery('shared', f.discovery.id);
  assert.equal(d.status, 'confirmed');
  assert.equal(d.confirmedPlaceIds.length, 7);
  assert.deepEqual(d.selectedCandidateIndices, [0, 1, 2, 3, 4, 5, 6]);
  const places = saved(f.db);
  assert.equal(places.length, 7);
  assert.ok(
    places.every(
      (p) => p.label === '春雨饺子' && p.labelSource === 'recognition',
    ),
  );
  assert.equal(new Set(places.map((p) => p.id)).size, 7);
  assert.deepEqual(
    new Set(places.map((p) => p.id)),
    new Set(candidates.map(canonicalPlaceId)),
  );
  const before = structuredClone(f.db.values);
  const result = await new ProjectionService(f.hydrator).project(places);
  assert.equal(result.counts.placesProjected, 7);
  assert.equal(result.counts.missingLabels, 0);
  assert.equal(
    new Set(result.places.map((p) => p.coordinates.latitude)).size,
    7,
  );
  assert.equal(new Set(result.places.map((p) => p.label)).size, 1);
  assert.deepEqual(f.db.values, before, 'projection never writes durable data');
  assert.equal(
    JSON.stringify([...f.db.values.values()]).includes('PROHIBITED_'),
    false,
  );
  const again = await f.repo.createDiscovery({ ...f.discovery, id: 'again' });
  const selected = await f.service.updateSelection(again, 'all');
  const done = await f.service.finish(selected, 'confirm');
  assert.equal(done.reusedCount, 7);
  assert.equal(saved(f.db).length, 7);
  assert.deepEqual(done.discovery.confirmedPlaceIds, d.confirmedPlaceIds);
});
test('six existing unlabeled Google records hydrate with neutral projection-only names; failure alone makes one unavailable', async () => {
  const f = await fixture({ mode: 'single_venue', visibleText: [], clues: [] });
  const d = await f.service.updateSelection(f.discovery, 'all');
  await f.service.finish(d, 'confirm');
  const places = saved(f.db).slice(0, 6),
    before = structuredClone(f.db.values);
  assert.ok(places.every((p) => p.label === undefined));
  const ok = await new ProjectionService(f.hydrator).project(places);
  assert.deepEqual(ok.counts, {
    placesTotal: 6,
    placesProjected: 6,
    googleHydrated: 6,
    providerFailures: 0,
    missingLabels: 0,
    invalidPlaces: 0,
    budgetSkipped: 0,
  });
  assert.ok(ok.places.every((p) => p.label === 'Saved location'));
  const partial = await new ProjectionService({
    refresh: async (identity) => {
      if (identity.id === places[0].providerIdentity.id)
        throw new Error('fixture provider unavailable');
      return f.hydrator.refresh(identity);
    },
  }).project(places);
  assert.equal(partial.counts.placesProjected, 5);
  assert.equal(partial.counts.providerFailures, 1);
  assert.equal(partial.counts.missingLabels, 0);
  assert.deepEqual(f.db.values, before);
});
test('branch-specific recognition is not copied to related branches without independent brand evidence', () => {
  const r = {
    ...recognition,
    clues: [
      {
        ...recognition.clues[0],
        name: 'Spring Rain Dumplings North',
        nativeName: '春雨饺子北店',
        possibleChain: undefined,
      },
    ],
  };
  assert.equal(candidateRecognitionLabel(r, candidates[1]), undefined);
  assert.equal(recognitionLabel(r).label, '春雨饺子北店');
});
test('archived canonical identity is not presented as actively saved and explicit confirmation restores it without duplicating or relabelling', async () => {
  const f = await fixture();
  const selected = await f.service.updateSelection(f.discovery, 'all');
  const first = await f.service.finish(selected, 'confirm');
  const p = first.places[1];
  await f.repo.savePlace({
    ...p,
    status: 'archived',
    label: '我的饺子店',
    labelSource: 'user',
  });
  const again = await f.repo.createDiscovery({ ...f.discovery, id: 'restore' });
  await f.telegram.propose(again, 11, 1);
  // Exercises the actual active-status check for both canonical identities.
  assert.equal(await f.telegram.alreadySaved(again, 0), true);
  assert.equal(await f.telegram.alreadySaved(again, 1), false);
  const selection = await f.service.updateSelection(again, 'all');
  const done = await f.service.finish(selection, 'confirm');
  assert.equal(done.reusedCount, 7);
  const restored = await f.repo.getPlace('shared', p.id);
  assert.equal(restored.status, 'confirmed');
  assert.equal(restored.label, '我的饺子店');
  assert.equal(restored.createdAt, p.createdAt);
  assert.equal(saved(f.db).length, 7);
});
