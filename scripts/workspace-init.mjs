import { Firestore } from '@google-cloud/firestore';
import { WorkspaceSchema, IdSchema } from '@places/schemas';
import { FirestoreRepository } from '@places/providers';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export async function initializeWorkspace(repository, id, locale = 'en') {
  const time = new Date().toISOString();
  const workspace = WorkspaceSchema.parse({
    id: IdSchema.parse(id),
    members: [],
    settings: { locale },
    createdAt: time,
    updatedAt: time,
  });
  return repository.initWorkspace(workspace);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--id') throw new Error();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? 'mom-im-ok-places';
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) throw new Error();
    const workspace = await initializeWorkspace(
      new FirestoreRepository(new Firestore({ projectId })),
      args[1],
    );
    console.info(
      JSON.stringify({
        workspaceId: workspace.id,
        members: workspace.members.length,
        locale: workspace.settings.locale,
        compatible: true,
      }),
    );
  } catch {
    console.error(
      'workspace_initialization_failed:check_id_ADC_IAM_and_existing_workspace',
    );
    process.exitCode = 1;
  }
}
