import { asRecord, readRouteParam, rejectUnknownFields } from '../../shared/validation/http';

export function parseFileId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'fileId');
}

export function parseDownloadQuery(query: unknown): void {
  const record = asRecord(query, 'query');
  rejectUnknownFields(record, []);
}

export function parseDownloadBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }

  if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) {
    return;
  }

  const record = asRecord(body);
  rejectUnknownFields(record, []);
}
