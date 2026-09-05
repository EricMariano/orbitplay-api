/** Metadata returned by a server-side HEAD of an object. */
export interface StorageObjectMeta {
  contentType?: string;
  sizeBytes: number;
}

export interface MultipartPart {
  partNumber: number;
  etag: string;
}
/**
 * Object storage capability. Implemented by the MinIO adapter in every
 * environment (MinIO speaks the S3 protocol — it is not an AWS coupling).
 */
export interface StoragePort {
  /** Presigned URL a client can PUT bytes to directly. */
  createUploadUrl(key: string, contentType: string, expiresInSeconds?: number): Promise<string>;
  /** Presigned URL a client can GET bytes from directly. */
  createDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  /** Start a multipart upload; returns the storage `uploadId`. */
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  /** Presigned URL for a single multipart part (client PUTs bytes there). */
  createUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number,
  ): Promise<string>;
  /** Assemble previously uploaded parts into the final object. */
  completeMultipartUpload(key: string, uploadId: string, parts: MultipartPart[]): Promise<void>;
  /** Abort an in-flight multipart upload (best-effort). */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  /** Server-side copy (used for derived objects such as extracted audio). */
  copyObject(sourceKey: string, destKey: string): Promise<void>;
  /** Server-side object existence check. */
  exists(key: string): Promise<boolean>;
  /** HEAD an object; `null` when the key is absent. */
  stat(key: string): Promise<StorageObjectMeta | null>;
  /** Delete an object (no-op if absent). */
  remove(key: string): Promise<void>;
  /** Liveness check for /health (e.g. HEAD the bucket). */
  healthCheck(): Promise<void>;
}

export const STORAGE_PORT = Symbol('STORAGE_PORT');
