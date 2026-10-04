import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
export class GoogleSecrets {
  private readonly client = new SecretManagerServiceClient();
  constructor(private readonly projectId: string) {}
  async read(name: 'TELEGRAM_BOT_TOKEN' | 'GEMINI_API_KEY'): Promise<string> {
    const [version] = await this.client.accessSecretVersion({
      name: `projects/${this.projectId}/secrets/${name}/versions/latest`,
    });
    const value = version.payload?.data?.toString();
    if (!value) throw new Error('secret_unavailable');
    return value;
  }
}
