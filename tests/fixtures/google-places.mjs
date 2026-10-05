import { GooglePlacesPoi } from '@places/providers';
export const recognition = {
  visibleText: ['PRIVATE_VISIBLE_TEXT'],
  clues: [
    {
      name: 'Fixture Cafe',
      nativeName: '示例咖啡馆',
      aliases: ['Fixture Coffee'],
      category: 'cafe',
      areaHint: 'Shanghai',
      confidence: 0.95,
    },
  ],
};
export const verification = {
  status: 'verified',
  candidates: [
    {
      canonicalName: 'Fixture Cafe',
      nativeName: '示例咖啡馆',
      aliases: ['Fixture Coffee', 'FC Shanghai'],
      category: 'cafe',
      city: 'Shanghai',
      cityAliases: ['上海', '上海市', 'Шанхай'],
      countryCode: 'CN',
      addressClue: '18 Fixture Road',
      confidence: 0.95,
    },
  ],
  references: [
    {
      provider: 'openai-web-search',
      url: 'https://example.org/fixture',
      observedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};
export const row = {
  id: 'fixture-google-place-1',
  displayName: { text: 'Fixture Café', languageCode: 'en' },
  formattedAddress: '18 Fixture Rd, Shanghai, China',
  location: { latitude: 31.23, longitude: 121.45 },
  types: ['cafe', 'food', 'point_of_interest', 'establishment'],
  addressComponents: [
    { longText: '18', shortText: '18', types: ['street_number'] },
    { longText: 'Fixture Road', shortText: 'Fixture Rd', types: ['route'] },
    {
      longText: 'Shanghai',
      shortText: 'Shanghai',
      types: ['locality', 'political'],
    },
    { longText: 'China', shortText: 'CN', types: ['country', 'political'] },
  ],
  attributions: [
    {
      provider: 'Fixture attribution',
      providerUri: 'https://example.org/provider',
    },
  ],
};
export const token = 'fixture-access-token';
export const project = 'fixture-project';
export function googleFixture(body = { places: [row] }, request, telemetry) {
  return new GooglePlacesPoi(
    async () => token,
    project,
    request ??
      (async () => new Response(JSON.stringify(body), { status: 200 })),
    () => Date.parse('2026-01-01T00:00:00.000Z'),
    undefined,
    telemetry,
  );
}
