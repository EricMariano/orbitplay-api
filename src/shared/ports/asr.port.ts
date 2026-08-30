/**
 * Automatic speech recognition capability. StubAsrAdapter returns a fixed
 * transcript; Whisper (or similar) implements this later. No real ASR code now.
 */
export interface TranscribeRequest {
  organizationId: string;
  audioKey: string; // storage key of the audio object
  language?: string;
}

export interface Transcript {
  text: string;
  isFake: boolean;
}

export interface AsrPort {
  transcribe(request: TranscribeRequest): Promise<Transcript>;
}

export const ASR_PORT = Symbol('ASR_PORT');
