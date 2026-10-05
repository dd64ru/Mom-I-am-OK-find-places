import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
export class GoogleSecrets {
  private readonly client = new SecretManagerServiceClient();
  constructor(private readonly projectId: string) {}
  async read(
    name:
      | 'TELEGRAM_BOT_TOKEN'
      | 'GEMINI_API_KEY'
      | 'TELEGRAM_WEBHOOK_SECRET'
      | 'PLACES_FEED_TOKEN_SHA256',
  ): Promise<string> {
    try {
      const [version] = await this.client.accessSecretVersion({
        name: `projects/${this.projectId}/secrets/${name}/versions/latest`,
      });
      const value = version.payload?.data?.toString();
      if (!value) throw new Error();
      return value;
    } catch {
      throw new Error('secret_unavailable');
    }
  }
}
