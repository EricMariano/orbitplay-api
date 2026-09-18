import { describe, expect, it } from 'vitest';
import { testModelKeyValues } from './dto/test-model.dto';
import { TestModelsService } from './test-models.service';

describe('TestModelsService', () => {
  const service = new TestModelsService();

  it('lists the four designed models, in catalog order', () => {
    const models = service.list();
    expect(models.map((m) => m.key)).toEqual([
      'free_exploration',
      'free_exploration_telemetry',
      'ab_test',
      'ab_test_images',
    ]);
  });

  it('every listed key is one of the designed TestModelKey values', () => {
    for (const model of service.list()) {
      expect(testModelKeyValues).toContain(model.key);
    }
  });

  it('marks free_exploration_telemetry unavailable, pending the Orbit Plug-in', () => {
    const model = service.get('free_exploration_telemetry');
    expect(model.requiresTelemetry).toBe(true);
    expect(model.available).toBe(false);
    expect(model.unavailableReason).toBeTruthy();
  });

  it('marks the other three models available with no requiresTelemetry', () => {
    for (const key of ['free_exploration', 'ab_test', 'ab_test_images']) {
      const model = service.get(key);
      expect(model.available).toBe(true);
      expect(model.requiresTelemetry).toBe(false);
      expect(model.unavailableReason).toBeNull();
    }
  });

  it('requires a build for every model except ab_test_images (GAP-03)', () => {
    for (const key of ['free_exploration', 'free_exploration_telemetry', 'ab_test']) {
      expect(service.get(key).requiresBuild).toBe(true);
    }
    expect(service.get('ab_test_images').requiresBuild).toBe(false);
  });

  it("ab_test's copy asks for one build per variant test, not two builds in one test (GAP-03)", () => {
    const model = service.get('ab_test');
    expect(model.description).not.toMatch(/duas builds/i);
    expect(model.technicalRequirements.join(' ')).not.toMatch(/duas builds/i);
  });

  it('throws a 404 app exception for an unknown key', () => {
    let error: unknown;
    try {
      service.get('not_a_real_model');
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ status: 404 });
  });
});
