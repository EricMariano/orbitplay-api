import type { Readable } from 'node:stream';
import type { MalwareScannerPort, ScanResult } from '../../shared/ports/malware-scanner.port';

/**
 * Dev-only stand-in (`BUILD_MALWARE_SCAN_BYPASS=true`): reads nothing and
 * reports `skipped`, never `clean`, so a bypassed build can't be mistaken
 * for a scanned one. `buildConfig` refuses the bypass in production.
 */
export class SkippedScannerAdapter implements MalwareScannerPort {
  async scan(stream: Readable): Promise<ScanResult> {
    stream.destroy();
    return { verdict: 'skipped' };
  }
}
