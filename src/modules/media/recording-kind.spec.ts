import { describe, expect, it } from 'vitest';
import {
  recordingKindApiValues,
  recordingKindDbValues,
  toApiRecordingKind,
  toDbRecordingKind,
} from './recording-kind';

describe('recording-kind mapping', () => {
  it('maps every API name onto an existing SQL value (no third enum)', () => {
    const db = new Set<string>(recordingKindDbValues);
    for (const api of recordingKindApiValues) {
      expect(db.has(toDbRecordingKind(api))).toBe(true);
    }
  });

  it('round-trips screen_recording ↔ screen', () => {
    expect(toDbRecordingKind('screen_recording')).toBe('screen');
    expect(toApiRecordingKind('screen')).toBe('screen_recording');
  });

  it('leaves webcam and microphone unchanged', () => {
    expect(toDbRecordingKind('webcam')).toBe('webcam');
    expect(toDbRecordingKind('microphone')).toBe('microphone');
    expect(toApiRecordingKind('webcam')).toBe('webcam');
    expect(toApiRecordingKind('microphone')).toBe('microphone');
  });
});
