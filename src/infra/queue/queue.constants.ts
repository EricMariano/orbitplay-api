/** Names of the BullMQ queues. Keep in sync with the worker process. */
export const MAIN_QUEUE = 'main';

/** Job names handled on the main queue (extended as features land). */
export const JobName = {
  /** Placeholder job proving the queue wiring end-to-end. */
  PING: 'ping',
  /** Turn the uploaded recording into a playable object + thumbnail. */
  MEDIA_TRANSCODE: 'media.transcode',
  /** Extract an audio sidecar so ASR can plug in later (deferred). */
  MEDIA_EXTRACT_AUDIO: 'media.extract-audio',
} as const;

export type JobNameValue = (typeof JobName)[keyof typeof JobName];
