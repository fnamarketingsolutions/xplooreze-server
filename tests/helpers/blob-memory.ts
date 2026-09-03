import type {
  BlobObjectMetadata,
  BlobObjectStore,
  PresignedBlobDownloadUrl,
  PresignedBlobUploadUrl,
} from '../../src/integrations/blob/blob.operations';

type StoredBlob = {
  body: Buffer;
  contentType: string;
};

const objects = new Map<string, StoredBlob>();
let lastPresignedDownload: {
  locator: string;
  expiresInSeconds: number;
} | null = null;

export function resetMemoryBlob(): void {
  objects.clear();
  lastPresignedDownload = null;
}

export function putMemoryBlob(locator: string, body: Buffer, contentType: string): void {
  objects.set(locator, { body, contentType });
}

export function getMemoryBlob(locator: string): StoredBlob | undefined {
  return objects.get(locator);
}

export function getLastPresignedDownload(): typeof lastPresignedDownload {
  return lastPresignedDownload;
}

export function createMemoryBlobStore(): BlobObjectStore {
  return {
    async headObject(locator: string): Promise<BlobObjectMetadata | null> {
      const stored = objects.get(locator);

      if (!stored) {
        return null;
      }

      return {
        contentType: stored.contentType,
        contentLength: stored.body.length,
      };
    },

    async getObjectRange(locator: string, start: number, end: number): Promise<Buffer | null> {
      const stored = objects.get(locator);

      if (!stored) {
        return null;
      }

      return stored.body.subarray(start, end + 1);
    },

    async createPresignedUploadUrl(input): Promise<PresignedBlobUploadUrl> {
      return {
        url: `https://blob.test/upload/${input.locator}`,
        expiresAt: new Date(input.now.getTime() + input.expiresInSeconds * 1000),
      };
    },

    async createPresignedDownloadUrl(input): Promise<PresignedBlobDownloadUrl> {
      lastPresignedDownload = {
        locator: input.locator,
        expiresInSeconds: input.expiresInSeconds,
      };

      const token = Buffer.from(input.locator).toString('base64url');

      return {
        url: `https://blob.test/download/${token}?expires=${input.expiresInSeconds}`,
        expiresAt: new Date(input.now.getTime() + input.expiresInSeconds * 1000),
      };
    },

    async deleteObject(locator: string): Promise<void> {
      objects.delete(locator);
    },
  };
}
