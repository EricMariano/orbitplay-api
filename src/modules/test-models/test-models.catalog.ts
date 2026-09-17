import type { TestModelView } from './dto/test-model.dto';

/**
 * RN-03 (Tela 06): the catalog is backend-owned — the UI never defines copy or
 * technical requirements. Copy below is a placeholder pending the final
 * content handoff from product/Figma (see DECISIONS.md); structure and flags
 * (`requiresTelemetry`, `available`) follow BACKEND-SPEC.md §M4.
 */
export const TEST_MODEL_CATALOG: readonly TestModelView[] = [
  {
    key: 'free_exploration',
    name: 'Exploração livre',
    description:
      'O jogador explora o build sem roteiro fixo e, ao final, responde ao formulário e avalia a experiência. Bom para captar reações genuínas de primeiro contato.',
    deliverables: [
      'Gravação de tela e webcam (quando habilitadas)',
      'Respostas do formulário',
      'Avaliação do jogador',
    ],
    technicalRequirements: [
      'Build validada e compatível com o dispositivo do jogador',
      'Consentimento de gravação quando a etapa exigir',
    ],
    requiresTelemetry: false,
    available: true,
    unavailableReason: null,
  },
  {
    key: 'free_exploration_telemetry',
    name: 'Exploração livre com telemetria',
    description:
      'Mesma dinâmica da exploração livre, com captura automática de eventos de jogo (heatmaps, gatilhos) via Orbit Plug-in integrado ao build.',
    deliverables: [
      'Gravação de tela e webcam (quando habilitadas)',
      'Eventos de telemetria (heatmap, gatilhos)',
      'Respostas do formulário',
      'Avaliação do jogador',
    ],
    technicalRequirements: [
      'Orbit Plug-in integrado ao build e detectado na sessão',
      'Build validada e compatível com o dispositivo do jogador',
    ],
    requiresTelemetry: true,
    available: false,
    unavailableReason: 'O Orbit Plug-in ainda não está disponível nesta fase da plataforma.',
  },
  {
    key: 'ab_test',
    name: 'Teste A/B',
    description:
      'Compara duas versões do build entre grupos de jogadores para medir diferença de comportamento e preferência.',
    deliverables: [
      'Distribuição de sessões entre as variantes A e B',
      'Comparativo de respostas do formulário por variante',
      'Avaliação do jogador por variante',
    ],
    technicalRequirements: [
      'Duas builds válidas, uma por variante',
      'Critério de distribuição definido na Etapa 3',
    ],
    requiresTelemetry: false,
    available: true,
    unavailableReason: null,
  },
  {
    key: 'ab_test_images',
    name: 'Teste A/B de imagens',
    description:
      'Compara duas ou mais imagens (capa, banner, arte promocional) para medir preferência do público, sem exigir um build jogável.',
    deliverables: [
      'Distribuição de respostas por imagem',
      'Preferência agregada por variante',
    ],
    technicalRequirements: ['Imagens das variantes em PNG, JPEG ou WebP'],
    requiresTelemetry: false,
    available: true,
    unavailableReason: null,
  },
];
