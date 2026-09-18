import type { Readable } from 'node:stream';

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
  /**
   * Presigned URL a client can PUT bytes to directly. `sizeBytes` is signed
   * into the URL as `Content-Length` — S3/MinIO then rejects any PUT whose
   * actual `Content-Length` header doesn't match exactly, so the declared
   * size is a real, server-enforced ceiling instead of advisory metadata a
   * client can ignore (SEC-06).
   */
  createUploadUrl(
    key: string,
    contentType: string,
    sizeBytes: number,
    expiresInSeconds?: number,
  ): Promise<string>;
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
  /** Server-side copy of an existing object to a new key. */
  copyObject(sourceKey: string, destKey: string): Promise<void>;
  /**
   * Server-side upload of bytes the worker itself produced (thumbnails,
   * extracted audio) — never a client-facing presigned URL. Contrast with
   * `createUploadUrl`, which never sees the actual bytes.
   */
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Server-side object existence check. */
  exists(key: string): Promise<boolean>;
  /** HEAD an object; `null` when the key is absent. */
  stat(key: string): Promise<StorageObjectMeta | null>;
  /**
   * Open a read stream over an object's actual bytes for server-side
   * processing (checksum hashing, magic-byte format sniffing, future
   * malware scanning). Never exposed to clients — contrast with
   * `createDownloadUrl`, which hands a client a presigned URL.
   */
  getObjectStream(key: string): Promise<Readable>;
  /** Delete an object (no-op if absent). */
  remove(key: string): Promise<void>;
  /** Liveness check for /health (e.g. HEAD the bucket). */
  healthCheck(): Promise<void>;
}

export const STORAGE_PORT = Symbol('STORAGE_PORT');
