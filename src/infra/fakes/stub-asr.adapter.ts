import { Injectable } from '@nestjs/common';
import type { AsrPort, Transcript, TranscribeRequest } from '../../shared/ports/asr.port';

/** Stub ASR adapter: a fixed transcript, explicitly flagged as fake. */
@Injectable()
export class StubAsrAdapter implements AsrPort {
  transcribe(_request: TranscribeRequest): Promise<Transcript> {
    return Promise.resolve({
      text: 'Transcrição de exemplo (stub) — sem ASR real nesta etapa.',
      isFake: true,
    });
  }
}
