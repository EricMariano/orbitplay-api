import type { TestModelKey } from '../test-models/dto/test-model.dto';
import type { ConsentKind, TutorialView } from './dto/consent.dto';

/**
 * RN-01 (Tela 16): tutorial content is keyed by test MODEL, not by game —
 * same placeholder-pending-content-handoff pattern already used by
 * `TEST_MODEL_CATALOG` (test-models.catalog.ts). `ab_test_images` requires no
 * recording of any kind (it compares static images, no playable build).
 */
const RECORDING_STEPS: TutorialView['steps'] = [
  {
    title: 'Antes de começar',
    body: 'Você vai jogar o build enviado pelo estúdio e, ao final, responder algumas perguntas sobre a experiência.',
    mediaUrl: null,
  },
  {
    title: 'Permissões',
    body: 'Vamos pedir permissão para gravar a tela (obrigatório) e, quando o estúdio solicitar, também a webcam e o microfone.',
    mediaUrl: null,
  },
  {
    title: 'Durante o teste',
    body: 'Jogue normalmente. Você pode encerrar a sessão a qualquer momento — o progresso até ali já conta.',
    mediaUrl: null,
  },
];

const IMAGE_STEPS: TutorialView['steps'] = [
  {
    title: 'Antes de começar',
    body: 'Você vai ver algumas imagens e responder qual delas prefere. Não é necessário instalar nada.',
    mediaUrl: null,
  },
];

const RECORDING_CONSENTS: ConsentKind[] = ['screen_recording'];
const NO_CONSENTS: ConsentKind[] = [];

const TUTORIAL_BY_MODEL: Record<TestModelKey, Omit<TutorialView, 'modelKey'>> = {
  free_exploration: { steps: RECORDING_STEPS, requiredConsents: RECORDING_CONSENTS },
  free_exploration_telemetry: { steps: RECORDING_STEPS, requiredConsents: RECORDING_CONSENTS },
  ab_test: { steps: RECORDING_STEPS, requiredConsents: RECORDING_CONSENTS },
  ab_test_images: { steps: IMAGE_STEPS, requiredConsents: NO_CONSENTS },
};

export function tutorialForModel(modelKey: TestModelKey): TutorialView {
  return { modelKey, ...TUTORIAL_BY_MODEL[modelKey] };
}
