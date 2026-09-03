import type { FileStatus } from '../../database/models/enums';

export type StudentSubmissionFileDto = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: FileStatus;
  createdAt: string;
};

export type PdfUploadAuthorizationDto = {
  fileId: string;
  uploadUrl: string;
  method: 'PUT';
  headers: { 'Content-Type': string };
  expiresAt: string;
  file: StudentSubmissionFileDto;
};

export type SubmissionFileDownloadDto = {
  downloadUrl: string;
};

type SubmissionFileLike = {
  _id: { toString(): string };
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: FileStatus;
  createdAt: Date;
};

export function toStudentSubmissionFileDto(file: SubmissionFileLike): StudentSubmissionFileDto {
  return {
    id: file._id.toString(),
    originalName: file.originalName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    createdAt: file.createdAt.toISOString(),
  };
}
