# OrbitPlay — DER

Diagrama entidade-relacionamento do banco, derivado de [`DATA-MODEL.md`](./DATA-MODEL.md).

Dividido em clusters porque um único diagrama com as ~41 tabelas não seria
legível. Cada cluster repete as entidades de fronteira (em geral `USERS`,
`ORGANIZATIONS`, `GAMES`, `TESTS`, `SESSIONS`) para que cada diagrama se
sustente sozinho.

**Legenda de situação**

| Marca no comentário | Significa                                                              |
| ------------------- | ---------------------------------------------------------------------- |
| `[existe]`          | tabela já criada e em uso                                              |
| `[criada, sem uso]` | tabela existe, nenhum código a consome                                 |
| `[novo]`            | a criar no escopo de plataforma                                        |
| `[congelada]`       | existe, dormente, contrato imutável (SDK e builds publicadas dependem) |

Tabelas deferidas (pagamento, carteira, boost, insights, transcrição) **não
aparecem** — ver `BACKEND-SPEC.md` §10.

---

## 1. Visão geral — a espinha do domínio

O caminho que liga o estúdio ao jogador. É o eixo que todo o resto pendura.

```mermaid
flowchart LR
    subgraph tenancy["Fronteira de tenancy"]
        ORG[organizations]
        GAME[games]
        TEST[tests]
        BUILD[builds]
    end

    subgraph exec["Execução — jogador"]
        PART[participations]
        SESS[sessions]
        VAL[session_validations]
    end

    subgraph result["Resultado"]
        XP[xp_events]
        REP[test_report_snapshots]
    end

    USER[users]

    ORG -->|1:N| GAME
    GAME -->|1:N| TEST
    TEST -->|1:1| BUILD
    TEST -->|1:N vagas| PART
    USER -->|jogador reserva| PART
    PART -->|1:N| SESS
    SESS -->|1:1 gatilho| VAL
    VAL -->|libera| XP
    VAL -->|agrega| REP
    REP -.->|lido por| ORG

    style VAL stroke-width:3px
```

`session_validations` está destacada porque é o **gatilho**: nada de XP,
conquista ou recompensa acontece antes dela. É por isso que ela é uma tabela
própria, e não um campo booleano em `sessions` — a transição precisa ser um
insert único e transacional.

`organization_id` desce de `organizations` até `sessions` e é aplicado pelo
`BaseRepository`, nunca pelo serviço.

---

## 2. Auth e tenancy

```mermaid
erDiagram
    USERS ||--o{ MEMBERSHIPS : "pertence via"
    ORGANIZATIONS ||--o{ MEMBERSHIPS : "tem membros via"
    ROLES ||--o{ MEMBERSHIPS : "define papel de"
    USERS ||--o{ REFRESH_TOKENS : "possui"
    USERS ||--o{ PASSWORD_RESET_TOKENS : "solicita"
    USERS ||--o{ AUDIT_LOG : "é autor de"
    ORGANIZATIONS ||--o{ GAMES : "possui"
    USERS ||--o| ORGANIZATIONS : "é owner de"

    USERS {
        uuid id PK "[existe]"
        text email UK
        text password_hash "argon2 — nunca retornado"
        date birthdate "plataforma 18+"
        timestamptz deleted_at "desativação lógica"
    }
    ORGANIZATIONS {
        uuid id PK "[existe]"
        uuid owner_user_id FK "nunca pode ficar sem owner ativo"
        text slug UK
    }
    MEMBERSHIPS {
        uuid id PK "[existe]"
        uuid user_id FK
        uuid organization_id FK
        uuid role_id FK "papel vai no access token"
        membership_status status "active | invited | disabled"
    }
    ROLES {
        uuid id PK "[existe]"
        text key UK "owner | admin | studio | player"
    }
    REFRESH_TOKENS {
        uuid id PK "[existe]"
        uuid user_id FK
        text token_hash
        timestamptz revoked_at "rotação + detecção de reuso"
    }
    PASSWORD_RESET_TOKENS {
        uuid id PK
        uuid user_id FK
        text token_hash
        timestamptz expires_at "uso único, vida curta"
        timestamptz used_at
    }
    AUDIT_LOG {
        uuid id PK "[existe] — falta expor"
        uuid actor_user_id FK
        text action
        jsonb metadata
    }
```

`PASSWORD_RESET_TOKENS` alimenta `POST /auth/password/forgot` e
`POST /auth/password/reset`: o token de uso único (hash) fica aqui; ao
redefinir, `used_at` é setado e as sessões ativas do usuário são revogadas.

---

## 3. Jogo, teste e build

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ GAMES : "possui"
    GAMES ||--o{ GAME_ASSETS : "tem imagens"
    GAMES ||--o{ TESTS : "recebe"
    TESTS ||--|| TEST_AUDIENCE_CRITERIA : "define público"
    TESTS ||--o{ TEST_FORM_QUESTIONS : "tem formulário"
    TEST_FORM_QUESTIONS ||--o{ TEST_FORM_OPTIONS : "tem opções"
    TESTS ||--o| BUILDS : "testa a versão"
    BUILDS ||--o{ BUILD_VALIDATION_STEPS : "valida em etapas"
    BUILDS ||--o{ PLUGIN_MANIFESTS : "FK a criar"

    GAMES {
        uuid id PK "[existe]"
        uuid organization_id FK "tenancy"
        text slug "unique por organização"
        game_status status "draft | active | archived"
    }
    GAME_ASSETS {
        uuid id PK "[criada, sem uso]"
        uuid game_id FK
        asset_kind kind "cover | banner | screenshot"
        text storage_key "bytes no MinIO"
    }
    TESTS {
        uuid id PK "[novo]"
        uuid organization_id FK "tenancy"
        uuid game_id FK
        test_model_key model_key
        test_status status "draft | published | paused | finished | expired"
        wizard_step current_step "rascunho persistido do wizard"
        int slots_total
        int slots_taken "contador concorrente — ver nota"
        text publish_idempotency_key UK "recarregar não cria 2o teste"
        int reward_amount_cents "devido ao tester"
        text report_stage "none | partial | final"
    }
    TEST_AUDIENCE_CRITERIA {
        uuid test_id PK "[novo]"
        int age_min "minimo 18"
        int age_max
        int estimated_reach "calculado no servidor, precisa ser maior que 0"
    }
    TEST_FORM_QUESTIONS {
        uuid id PK "[novo]"
        uuid test_id FK
        question_type type
        boolean required "bloqueia envio do jogador"
        int position UK "unique por teste — ordem exata"
    }
    TEST_FORM_OPTIONS {
        uuid id PK "[novo]"
        uuid question_id FK
        int position UK "unique por pergunta"
    }
    BUILDS {
        uuid id PK "[novo]"
        uuid test_id FK
        text checksum
        text storage_key
        build_status status
    }
    BUILD_VALIDATION_STEPS {
        uuid id PK "[novo]"
        uuid build_id FK
        build_step_key key "checksum | malware_scan | metadata | plugin_manifest"
        text status "lista de etapas, não booleano"
    }
    PLUGIN_MANIFESTS {
        uuid id PK "[congelada]"
        uuid build_id FK "hoje SEM FK — órfã"
    }
```

Dois pontos que o diagrama expõe:

- **`PLUGIN_MANIFESTS` está órfã.** `build_id` é um `uuid` sem FK porque
  `builds` não existia (`DECISIONS.md` §1.3). A migração que cria `builds` é o
  momento de fechar essa dívida, mesmo com o plug-in fora de escopo.
- **`BUILD_VALIDATION_STEPS` já inclui `plugin_manifest` no enum.** O passo
  entra depois sem migração de enum, e a UI consegue mostrar _onde_ a validação
  falhou em vez de só "falhou".

---

## 4. Participação e sessão

```mermaid
erDiagram
    TESTS ||--o{ PARTICIPATIONS : "abre vagas"
    USERS ||--o{ PARTICIPATIONS : "jogador reserva"
    PARTICIPATIONS ||--|| SESSION_CONSENTS : "consente antes"
    PARTICIPATIONS ||--o{ SESSIONS : "executa"
    SESSIONS ||--o{ SESSION_DEVICE_EVENTS : "registra mic/webcam"
    SESSIONS ||--o{ SESSION_RECORDINGS : "grava"
    SESSIONS ||--o| SESSION_VALIDATIONS : "é validada por"
    SESSIONS ||--o| FORM_RESPONSES : "recebe respostas"
    FORM_RESPONSES ||--o{ FORM_ANSWERS : "contém"
    TEST_FORM_QUESTIONS ||--o{ FORM_ANSWERS : "responde a"

    PARTICIPATIONS {
        uuid id PK "[novo]"
        uuid test_id FK,UK "unique parcial com user_id enquanto ativa"
        uuid user_id FK,UK "unique parcial com test_id enquanto ativa"
        participation_status status
        text resume_point "ponto de retomada do modelo"
        text idempotency_key
    }
    SESSION_CONSENTS {
        uuid participation_id PK "[novo]"
        boolean screen_recording
        boolean microphone
        boolean webcam
        timestamptz accepted_at "append-only — é prova"
    }
    SESSIONS {
        uuid id PK "[novo]"
        uuid participation_id FK
        uuid organization_id FK "tenancy"
        session_status status
        int duration_ms
        text finish_idempotency_key
    }
    SESSION_DEVICE_EVENTS {
        uuid id PK "[novo]"
        uuid session_id FK
        int t_ms "base temporal única da sessão"
        text kind "microphone | webcam"
    }
    SESSION_RECORDINGS {
        uuid id PK "[novo]"
        uuid session_id FK
        recording_kind kind "screen | webcam | microphone"
        text storage_key
        text status "ausente não derruba o resto"
    }
    SESSION_VALIDATIONS {
        uuid session_id PK "[novo]"
        boolean valid
        text reason
        timestamptz validated_at "gatilho de XP e recompensa"
    }
    FORM_RESPONSES {
        uuid id PK "[novo]"
        uuid session_id UK "unique — sem 2a avaliação"
        timestamptz submitted_at
    }
    FORM_ANSWERS {
        uuid id PK "[novo]"
        uuid response_id FK
        uuid question_id FK
    }
```

A unique parcial em `PARTICIPATIONS` — `(test_id, user_id)` enquanto o status
for ativo — é o que impede duas participações simultâneas no mesmo teste. Regra
de corrida não se resolve em código de serviço: dois pedidos simultâneos passam
pela checagem antes de qualquer um gravar.

Mesma lógica no unique de `FORM_RESPONSES.session_id`: é ele que garante que
reenviar o formulário não gera segunda avaliação.

---

## 5. Feed e gamificação

```mermaid
erDiagram
    USERS ||--o| PLAYER_PREFERENCES : "tem sinais de"
    USERS ||--o{ FEED_RANKING_SNAPSHOTS : "navega com"
    USERS ||--o{ XP_EVENTS : "acumula"
    SESSION_VALIDATIONS ||--o{ XP_EVENTS : "origina"
    USERS ||--o{ PLAYER_ACHIEVEMENTS : "desbloqueia"
    ACHIEVEMENTS ||--o{ PLAYER_ACHIEVEMENTS : "é desbloqueada em"
    USERS ||--o{ PLAYER_MISSIONS : "progride em"
    MISSIONS ||--o{ PLAYER_MISSIONS : "é cumprida em"

    PLAYER_PREFERENCES {
        uuid user_id PK "[novo]"
        text[] genres
        text[] platforms
        jsonb device_profile "compatibilidade no feed"
    }
    FEED_RANKING_SNAPSHOTS {
        text seed PK "[novo]"
        uuid user_id FK
        uuid[] item_ids "ordem congelada"
        timestamptz expires_at "TTL curto"
    }
    XP_EVENTS {
        uuid id PK "[novo]"
        uuid user_id FK,UK "unique composta com source_type e source_id"
        text source_type UK
        uuid source_id UK
        int xp "ledger append-only"
    }
    ACHIEVEMENTS {
        text key PK "[novo]"
        jsonb rule
    }
    PLAYER_ACHIEVEMENTS {
        uuid id PK "[novo]"
        uuid user_id FK,UK "unique composta com achievement_key"
        text achievement_key FK,UK
    }
    MISSIONS {
        text key PK "[novo]"
    }
    PLAYER_MISSIONS {
        uuid id PK "[novo]"
        uuid user_id FK
        text mission_key FK
    }
    RANKING_SNAPSHOTS {
        uuid id PK "[novo]"
        text scope "materializado por job"
        text period
        jsonb entries
    }
```

`FEED_RANKING_SNAPSHOTS` existe por um motivo específico: o cursor padrão da
API (UUIDv7) assume ordem cronológica estável, e um feed rankeado muda entre
requisições — paginar sem congelar a ordem produz item repetido e item pulado.
Como é efêmero, Redis é alternativa aceitável a uma tabela.

O XP total e o nível são **derivados** da soma de `XP_EVENTS`, nunca um contador
editável. A unique composta é o que faz "recarregar não duplica XP" valer no
banco, e não só no serviço.

---

## 6. Relatórios, comunidade e infra

```mermaid
erDiagram
    TESTS ||--o{ TEST_REPORT_SNAPSHOTS : "agrega em"
    GAMES ||--o{ GAME_REVIEWS : "recebe"
    USERS ||--o{ GAME_REVIEWS : "avalia"
    GAMES ||--o{ COMMUNITY_POSTS : "hospeda"
    USERS ||--o{ COMMUNITY_POSTS : "publica"
    COMMUNITY_POSTS ||--o{ COMMUNITY_REPORTS : "é denunciado em"
    USERS ||--o{ NOTIFICATIONS : "recebe"

    TEST_REPORT_SNAPSHOTS {
        uuid id PK "[novo]"
        uuid test_id FK,UK "unique composta com block_key"
        text block_key UK "um registro POR BLOCO"
        text status "processing | ready | failed"
        jsonb payload
    }
    GAME_REVIEWS {
        uuid id PK "[novo]"
        uuid game_id FK,UK "unique composta com user_id"
        uuid user_id FK,UK
        numeric rating
    }
    COMMUNITY_POSTS {
        uuid id PK "[novo]"
        uuid game_id FK
        uuid author_user_id FK
        post_status status "visible | hidden | removed"
        uuid moderated_by FK
    }
    COMMUNITY_REPORTS {
        uuid id PK "[novo]"
        uuid post_id FK
        text reason
    }
    NOTIFICATIONS {
        uuid id PK "[novo]"
        uuid user_id FK
        text kind
        timestamptz read_at
    }
    IDEMPOTENCY_KEYS {
        text key PK "[novo]"
        text endpoint
        int response_status
        jsonb response_body "reproduz a resposta original"
        timestamptz expires_at
    }
```

`TEST_REPORT_SNAPSHOTS` guarda **um registro por bloco**, não um payload por
teste. É o que permite os blocos de telemetria e de IA entrarem depois como
blocos novos, e o que faz um bloco em erro não derrubar o relatório inteiro.

---

## 7. Congeladas — plug-in e telemetria

Existem no schema, dormentes. O contrato é **imutável**: o SDK e builds já
publicadas dependem desses formatos. Não mexer, mesmo com a telemetria fora de
escopo.

```mermaid
erDiagram
    BUILDS ||--o{ PLUGIN_MANIFESTS : "FK a criar"
    PLUGIN_MANIFESTS ||--o{ TRIGGER_DEFINITIONS : "declara gatilhos"
    SESSIONS ||--o{ SESSION_TOKENS : "autentica plug-in"
    SESSIONS ||--o{ TELEMETRY_EVENTS : "emite"
    SESSIONS ||--o{ HEATMAP_CELLS : "agrega em"

    PLUGIN_MANIFESTS {
        uuid id PK "[congelada]"
        uuid build_id "SEM FK hoje"
        text sdk_version
        jsonb raw_manifest
    }
    TRIGGER_DEFINITIONS {
        uuid id PK "[congelada]"
        uuid manifest_id FK
        trigger_type type "counter | timer | ui_event | vector | input"
    }
    SESSION_TOKENS {
        uuid id PK "[congelada]"
        uuid session_id
        text token_hash "auth do plug-in, não JWT de usuário"
        timestamptz expires_at
    }
    TELEMETRY_EVENTS {
        uuid id PK "[congelada]"
        uuid session_id
        text event_id UK "upsert por session_id + event_id"
        int t_ms "mesma base temporal do vídeo"
    }
    HEATMAP_CELLS {
        uuid session_id PK "[congelada]"
        int x PK
        int y PK
        int z PK
        int count "upsert incrementa"
    }
```

`TELEMETRY_EVENTS` é particionada por dia (`PARTITION BY RANGE (received_at)`),
o que o Drizzle não expressa — vive em `drizzle/manual/`.

---

## 8. Duas notas de implementação que o diagrama não mostra

**`tests.slots_taken` é um contador concorrente.** Vagas esgotando é exatamente
N jogadores pegando o último slot. Precisa ser
`UPDATE tests SET slots_taken = slots_taken + 1 WHERE id = ? AND slots_taken < slots_total`
numa transação, checando linhas afetadas — não `SELECT` seguido de `UPDATE`.

**Idempotência precisa de garantia no banco.** Guardar a chave só no Redis
resolve o caso feliz; duas requisições realmente simultâneas passam pelas duas
checagens antes de qualquer uma gravar. A proteção real são as unique
constraints marcadas nos diagramas — `tests.publish_idempotency_key`,
`form_responses.session_id`, `xp_events (user_id, source_type, source_id)` —
com o `23505` sendo capturado e convertido na resposta original.
