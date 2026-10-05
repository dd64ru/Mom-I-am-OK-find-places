// OSM categories are keys, types are values. Only explicit travel feature types are added;
// settlement, postal address, road and generic infrastructure results are not destinations here.
export function travelPoi(category: string, type: string): boolean {
  if (['amenity', 'shop', 'tourism', 'leisure', 'historic'].includes(category))
    return true;
  const additional: Record<string, readonly string[]> = {
    natural: [
      'peak',
      'volcano',
      'hill',
      'cliff',
      'cave_entrance',
      'beach',
      'bay',
      'cape',
      'spring',
      'water',
      'wood',
      'glacier',
      'rock',
      'arch',
      'stone',
    ],
    place: ['island', 'islet', 'square'],
    man_made: ['lighthouse', 'tower', 'observatory', 'windmill'],
    waterway: ['waterfall'],
    geological: ['palaeontological_site', 'outcrop'],
  };
  return additional[category]?.includes(type) ?? false;
}
