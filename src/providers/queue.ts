import { ManagedIdentityCredential } from "@azure/identity";
import { QueueClient } from "@azure/storage-queue";
export function decodeWake(body: string): string {
  if (body.length > 128) throw new Error("invalid_wake");
  const data: unknown = JSON.parse(body);
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    Object.keys(data).length !== 1 ||
    !("jobId" in data) ||
    typeof data.jobId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(data.jobId)
  )
    throw new Error("invalid_wake");
  return data.jobId;
}
export class WakeQueue {
  readonly client: QueueClient;
  constructor(url: string, clientId: string) {
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      !u.hostname.endsWith(".queue.core.windows.net") ||
      u.port ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !/^\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(u.pathname) ||
      !/^[0-9a-f-]{36}$/.test(clientId)
    )
      throw new Error("invalid_queue_config");
    // Managed identity only: never fall back to the developer's CLI or cached login.
    this.client = new QueueClient(
      url,
      new ManagedIdentityCredential({ clientId }),
      { retryOptions: { maxTries: 1 } },
    );
  }
  async send(jobId: string): Promise<void> {
    const body = JSON.stringify({ jobId });
    decodeWake(body);
    await this.client.sendMessage(body, {
      messageTimeToLive: 86400,
      abortSignal: AbortSignal.timeout(5000),
    });
  }
  async receive() {
    return (
      await this.client.receiveMessages({
        numberOfMessages: 1,
        visibilityTimeout: 60,
        abortSignal: AbortSignal.timeout(5000),
      })
    ).receivedMessageItems[0];
  }
  async acknowledge(id: string, receipt: string): Promise<void> {
    await this.client.deleteMessage(id, receipt, {
      abortSignal: AbortSignal.timeout(5000),
    });
  }
}
