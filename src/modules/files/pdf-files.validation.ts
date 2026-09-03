import {
  asRecord,
  readNumber,
  readRouteParam,
  readTrimmedString,
  rejectUnknownFields,
} from '../../shared/validation/http';

export function parseTestSeriesIdParam(value: string | string[] | undefined): string {
  return readRouteParam(value, 'testSeriesId');
}

export function parseFileIdParam(value: string | string[] | undefined): string {
  return readRouteParam(value, 'fileId');
}

export type FileUploadRequestInput = {
  originalName: string;
  mimeType: string;
  claimedSizeBytes: number;
};

export function parseFileUploadRequest(body: unknown): FileUploadRequestInput {
  const record = asRecord(body);
  rejectUnknownFields(record, ['originalName', 'contentType', 'sizeBytes']);

  return {
    originalName: readTrimmedString(record.originalName, 'originalName', 255),
    mimeType: readTrimmedString(record.contentType, 'contentType', 100),
    claimedSizeBytes: readNumber(record.sizeBytes, 'sizeBytes'),
  };
}

export function parseCompleteUploadBody(body: unknown): void {
  if (body === undefined || body === null) return;
  if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) return;
  const record = asRecord(body);
  rejectUnknownFields(record, []);
}

export function parseDeleteAnswerFileQuery(query: unknown): void {
  const record = asRecord(query, 'query');
  rejectUnknownFields(record, []);
}

export function parseDeleteAnswerFileBody(body: unknown): void {
  parseCompleteUploadBody(body);
}
