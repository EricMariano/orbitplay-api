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
    requiresBuild: true,
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
    requiresBuild: true,
    available: false,
    unavailableReason: 'O Orbit Plug-in ainda não está disponível nesta fase da plataforma.',
  },
  {
    key: 'ab_test',
    name: 'Teste A/B',
    // GAP-03: a build por variante — não duas builds num teste só. A
    // plataforma segue "uma build por teste" (DECISIONS.md §1.3; reforçado
    // pelo UNIQUE em builds.test_id); um A/B é montado como DOIS testes,
    // cada um com a build de uma variante, comparados depois no relatório.
    description:
      'Uma variante de um teste A/B: mesma dinâmica da exploração livre, com a build dessa variante. Para comparar duas versões, crie um segundo teste com a build alternativa — o comparativo entre as variantes entra no relatório.',
    deliverables: [
      'Distribuição de sessões desta variante',
      'Respostas do formulário desta variante',
      'Avaliação do jogador desta variante',
    ],
    technicalRequirements: [
      'Build validada e compatível com o dispositivo do jogador',
      'Um segundo teste com a build da variante comparada, para o comparativo no relatório',
    ],
    requiresTelemetry: false,
    requiresBuild: true,
    available: true,
    unavailableReason: null,
  },
  {
    key: 'ab_test_images',
    name: 'Teste A/B de imagens',
    description:
      'Compara duas ou mais imagens (capa, banner, arte promocional) para medir preferência do público, sem exigir um build jogável.',
    deliverables: ['Distribuição de respostas por imagem', 'Preferência agregada por variante'],
    technicalRequirements: ['Imagens das variantes em PNG, JPEG ou WebP'],
    requiresTelemetry: false,
    // GAP-03: a única flag que efetivamente libera publish sem build
    // validada — o gate genérico em TestsService.pendingValidationsFor
    // (BUILD_NOT_VALIDATED) agora consulta esta flag em vez de exigir build
    // incondicionalmente para todo modelo.
    requiresBuild: false,
    available: true,
    unavailableReason: null,
  },
];
