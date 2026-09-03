import { del, head, issueSignedToken, presignUrl } from '@vercel/blob';

import { getConfig, requireBlobConfig } from '../../config/index';

export type BlobObjectMetadata = {
  contentType: string | undefined;
  contentLength: number | undefined;
};

export type PresignedBlobUploadUrl = {
  url: string;
  expiresAt: Date;
};

export type PresignedBlobDownloadUrl = {
  url: string;
  expiresAt: Date;
};

export type BlobObjectStore = {
  headObject(locator: string): Promise<BlobObjectMetadata | null>;
  getObjectRange(locator: string, start: number, end: number): Promise<Buffer | null>;
  createPresignedUploadUrl(input: {
    locator: string;
    contentType: string;
    expiresInSeconds: number;
    maximumSizeInBytes: number;
    now: Date;
  }): Promise<PresignedBlobUploadUrl>;
  createPresignedDownloadUrl(input: {
    locator: string;
    expiresInSeconds: number;
    now: Date;
  }): Promise<PresignedBlobDownloadUrl>;
  deleteObject(locator: string): Promise<void>;
};

const OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/;
const PDF_CONTENT_TYPE = 'application/pdf';

let overrideStore: BlobObjectStore | null = null;

export function setBlobStoreForTests(store: BlobObjectStore | null): void {
  overrideStore = store;
}

export function submissionBlobLocator(fileId: string): string {
  if (!OBJECT_ID_PATTERN.test(fileId)) {
    throw new Error('Invalid file id for blob locator.');
  }

  return `${fileId}.pdf`;
}

export function questionBlobLocator(fileId: string): string {
  if (!OBJECT_ID_PATTERN.test(fileId)) {
    throw new Error('Invalid file id for blob locator.');
  }

  return `questions/${fileId}.pdf`;
}

export function answerBlobLocator(fileId: string): string {
  if (!OBJECT_ID_PATTERN.test(fileId)) {
    throw new Error('Invalid file id for blob locator.');
  }

  return `answers/${fileId}.pdf`;
}

function signedTokenOptions() {
  const config = requireBlobConfig(getConfig().blob);

  if (config.readWriteToken) {
    return { token: config.readWriteToken };
  }

  return {
    oidcToken: config.oidcToken,
    storeId: config.storeId,
  };
}

function blobAccess() {
  return requireBlobConfig(getConfig().blob).access;
}

async function createGetSignedUrl(locator: string, expiresAt: Date): Promise<string> {
  const token = await issueSignedToken({
    pathname: locator,
    operations: ['get'],
    validUntil: expiresAt.getTime(),
    ...signedTokenOptions(),
  });

  const { presignedUrl } = await presignUrl(token, {
    operation: 'get',
    pathname: locator,
    access: blobAccess(),
    validUntil: expiresAt.getTime(),
    useCache: false,
  });

  return presignedUrl;
}

function isBlobNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === 'BlobNotFoundError';
}

function liveStore(): BlobObjectStore {
  return {
    async headObject(locator: string): Promise<BlobObjectMetadata | null> {
      try {
        const result = await head(locator, {
          ...signedTokenOptions(),
        });

        return {
          contentType: result.contentType,
          contentLength: result.size,
        };
      } catch (error) {
        if (isBlobNotFoundError(error)) {
          return null;
        }

        throw error;
      }
    },

    async getObjectRange(locator: string, start: number, end: number): Promise<Buffer | null> {
      const expiresAt = new Date(Date.now() + 60_000);

      try {
        const presignedUrl = await createGetSignedUrl(locator, expiresAt);
        const response = await fetch(presignedUrl, {
          headers: {
            Range: `bytes=${start}-${end}`,
          },
        });

        if (response.status === 404) {
          return null;
        }

        if (!response.ok && response.status !== 206) {
          throw new Error(`Blob range request failed with status ${response.status}`);
        }

        const bytes = await response.arrayBuffer();
        return Buffer.from(bytes);
      } catch (error) {
        if (isBlobNotFoundError(error)) {
          return null;
        }

        throw error;
      }
    },

    async createPresignedUploadUrl(input): Promise<PresignedBlobUploadUrl> {
      const expiresAt = new Date(input.now.getTime() + input.expiresInSeconds * 1000);
      const token = await issueSignedToken({
        pathname: input.locator,
        operations: ['put'],
        allowedContentTypes: [input.contentType],
        maximumSizeInBytes: input.maximumSizeInBytes,
        validUntil: expiresAt.getTime(),
        ...signedTokenOptions(),
      });

      const { presignedUrl } = await presignUrl(token, {
        operation: 'put',
        pathname: input.locator,
        access: blobAccess(),
        allowedContentTypes: [input.contentType],
        maximumSizeInBytes: input.maximumSizeInBytes,
        addRandomSuffix: false,
        allowOverwrite: false,
        validUntil: expiresAt.getTime(),
      });

      return {
        url: presignedUrl,
        expiresAt,
      };
    },

    async createPresignedDownloadUrl(input): Promise<PresignedBlobDownloadUrl> {
      const expiresAt = new Date(input.now.getTime() + input.expiresInSeconds * 1000);
      const url = await createGetSignedUrl(input.locator, expiresAt);

      return {
        url,
        expiresAt,
      };
    },

    async deleteObject(locator: string): Promise<void> {
      await del(locator, {
        ...signedTokenOptions(),
      });
    },
  };
}

function store(): BlobObjectStore {
  return overrideStore ?? liveStore();
}

export async function createPresignedUploadUrl(input: {
  locator: string;
  contentType?: string;
  maximumSizeInBytes: number;
  now?: Date;
}): Promise<PresignedBlobUploadUrl> {
  const now = input.now ?? new Date();
  const ttl = getConfig().blob.uploadUrlTtlSeconds ?? 300;

  return store().createPresignedUploadUrl({
    locator: input.locator,
    contentType: input.contentType ?? PDF_CONTENT_TYPE,
    maximumSizeInBytes: input.maximumSizeInBytes,
    expiresInSeconds: ttl,
    now,
  });
}

export async function createPresignedDownloadUrl(input: {
  locator: string;
  now?: Date;
}): Promise<PresignedBlobDownloadUrl> {
  const now = input.now ?? new Date();
  const ttl = getConfig().blob.downloadUrlTtlSeconds ?? 60;

  return store().createPresignedDownloadUrl({
    locator: input.locator,
    expiresInSeconds: ttl,
    now,
  });
}

export async function headBlob(locator: string): Promise<BlobObjectMetadata | null> {
  return store().headObject(locator);
}

export async function getBlobRange(
  locator: string,
  start: number,
  end: number,
): Promise<Buffer | null> {
  return store().getObjectRange(locator, start, end);
}

export async function deleteBlob(locator: string): Promise<void> {
  return store().deleteObject(locator);
}

export const PDF_MAGIC_BYTES = Buffer.from('%PDF');

export function bufferStartsWithPdfMagic(value: Buffer): boolean {
  return value.subarray(0, PDF_MAGIC_BYTES.length).equals(PDF_MAGIC_BYTES);
}
