// Owner supplies a local export; no Firestore client or apply mode exists.
import { readFile } from 'node:fs/promises';
import { planLocalityBackfill } from '@places/core';
import { GooglePlacesPoi, googlePlacesAdc } from '@places/providers';
const [flag, file, projectFlag, project] = process.argv.slice(2);
if (
  flag !== '--input' ||
  !file ||
  projectFlag !== '--quota-project' ||
  !project
)
  throw new Error('plan_input_required');
const input = JSON.parse(await readFile(file, 'utf8'));
if (!Array.isArray(input)) throw new Error('invalid_plan_input');
const provider = new GooglePlacesPoi(googlePlacesAdc(project), project);
console.info(
  JSON.stringify(await planLocalityBackfill(input, provider), null, 2),
);
