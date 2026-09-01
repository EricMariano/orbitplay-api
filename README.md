# OrbitPlay API

Backend principal do OrbitPlay — NestJS + Drizzle + Postgres. Repositório
**exclusivo da API**. O front vive em `orbitplay-web` e consome esta API em
`http://localhost:3000` e o contrato em [`openapi.json`](#contrato-openapi).
Com a API rodando, a documentação interativa (Swagger UI) fica em
`http://localhost:3000/docs` (JSON cru em `/docs-json`).

Esta é a fatia de setup: ambiente local sobe com um comando, autenticação com
rotação de refresh, RBAC, uma fatia vertical completa (`games`) como molde,
migrações geradas + seed determinístico, e `openapi.json` versionado. Sem
pagamento/IA/ASR reais — apenas portas com adaptadores falsos.

---

## Pré-requisitos

- **Node 22 LTS** (veja `.nvmrc` — `nvm use` / `fnm use`)
- **pnpm 10** (`corepack enable`)
- **Docker** + Docker Compose
- **Git**

> **Nota de ambiente:** o projeto tem como alvo Node 22. Se rodar em Node 25, o
> script `openapi:generate` já gera a partir do build compilado para contornar
> uma incompatibilidade do `tsx` com Node 25 (detalhes em `DECISIONS.md`). Tudo
> o mais funciona igual.

---

## Subir do zero

```bash
docker compose -f docker/compose.yml up -d      # postgres, redis, minio, mailhog
pnpm install
cp .env.example .env                            # valores dev já preenchidos
pnpm db:migrate
pnpm db:seed
pnpm dev                                         # API em http://localhost:3000
```

Worker de jobs (processo separado, opcional nesta etapa):

```bash
pnpm dev:worker
```

Serviços locais (via `docker/compose.yml`):

| Serviço  | Porta       | Observação                                                           |
| -------- | ----------- | -------------------------------------------------------------------- |
| postgres | 5432        | banco principal                                                      |
| redis    | 6379        | filas BullMQ + store de idempotência                                 |
| minio    | 9000 / 9001 | storage S3 (console em :9001); bucket `orbitplay-dev` criado no boot |
| mailhog  | 1025 / 8025 | SMTP dev (UI em :8025)                                               |

A API roda **fora** do Docker, no host.

---

## Credenciais do seed

Uma organização (**OrbitPlay Studio Demo**), quatro usuários (um por papel) e
dois jogos. **Senha de todos:** `Orbit@Demo123`.

| E-mail                 | Papel  |
| ---------------------- | ------ |
| `owner@orbitplay.dev`  | owner  |
| `admin@orbitplay.dev`  | admin  |
| `studio@orbitplay.dev` | studio |
| `player@orbitplay.dev` | player |

Exemplo de login:

```bash
curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"studio@orbitplay.dev","password":"Orbit@Demo123"}'
```

Retorna `accessToken` no corpo e o refresh token num cookie `httpOnly`
(`SameSite=Lax`). Use `Authorization: Bearer <accessToken>` nas rotas
protegidas.

---

## Scripts

| Script                    | O que faz                                                |
| ------------------------- | -------------------------------------------------------- |
| `pnpm dev`                | API em watch                                             |
| `pnpm dev:worker`         | worker de jobs (BullMQ) em watch                         |
| `pnpm build` / `start`    | build de produção / rodar `dist/main.js`                 |
| `pnpm lint` / `typecheck` | ESLint / `tsc --noEmit`                                  |
| `pnpm test`               | testes de unidade (Vitest)                               |
| `pnpm test:e2e`           | e2e (Supertest) contra o banco de teste `orbitplay_test` |
| `pnpm db:generate`        | **gera** migração a partir do schema (Drizzle)           |
| `pnpm db:migrate`         | aplica migrações geradas **+** `drizzle/manual/*.sql`    |
| `pnpm db:seed`            | seed determinístico e idempotente                        |
| `pnpm db:reset`           | dropa schema, re-migra e (encadeado) prepara o banco     |
| `pnpm openapi:generate`   | gera `openapi.json` (via build compilado)                |

---

## Banco & migrações

O schema TypeScript em `src/infra/database/schema/` é a **única fonte da
verdade**. O fluxo é sempre:

```
edita schema .ts → pnpm db:generate → revisa o SQL em drizzle/ → pnpm db:migrate → commita schema + migração juntos
```

- **Nunca** edite arquivos em `drizzle/` à mão, nem escreva migração à mão.
- **Exceção única:** DDL que o Drizzle não expressa (particionamento, triggers,
  extensões, backfill) vai em `drizzle/manual/*.sql`, aplicada pelo mesmo runner
  (`db:migrate`), na ordem, e rastreada em `__manual_migrations`. Hoje há uma:
  `telemetry_events` particionada por dia.
- IDs são **UUID v7** (ordenáveis por tempo), gerados na aplicação.
- Toda tabela de domínio tem `organization_id`; o filtro de organização vive em
  `base.repository.ts` (RN-01), não nos services. Acesso cruzado responde
  **404**, não 403.

---

## Contrato OpenAPI

`pnpm openapi:generate` escreve `openapi.json` na raiz (versionado). É o contrato
que o `orbitplay-web` consome para **gerar os tipos** — não se duplica DTO à mão
dos dois lados. Toda mudança de contrato aparece no diff do PR.

Os DTOs são definidos uma vez com **Zod** (`nestjs-zod`): a mesma definição
valida em runtime e gera o schema OpenAPI. Combine o formato dos primeiros
endpoints com quem estiver no front antes de fechar.

---

## Estrutura de pastas

```
src/
├─ main.ts                     bootstrap (helmet, cors, cookies, pino)
├─ app.module.ts               wiring + guards/pipe/filter/interceptors globais
├─ openapi.ts                  geração do openapi.json
├─ config/                     env.schema (Zod, falha no boot) + configuration
├─ shared/
│  ├─ ports/                   interfaces das capacidades externas
│  ├─ guards/                  JwtAuth, Roles, OrgScope
│  ├─ interceptors/            Audit, Idempotency
│  ├─ filters/                 HttpExceptionFilter → envelope único
│  ├─ decorators/              @CurrentUser, @Roles, @Public
│  ├─ auth/ · audit/ · errors/ · pagination/ · util/
├─ infra/
│  ├─ database/                schema/, base.repository, client, migrate, seed, reset
│  ├─ redis/ · storage/ (MinIO) · mail/ (Mailhog) · queue/ (BullMQ)
│  ├─ telemetry/               TelemetryStore Postgres (SQL cru)
│  └─ fakes/                   FakePayment, StubAi, StubAsr
├─ modules/
│  ├─ health/ · iam/ · orgs/ · games/ (fatia vertical) · audit/
└─ workers/
   └─ main.worker.ts           processo separado dos jobs

drizzle/            migrações geradas (versionadas) + manual/
test/               e2e (Supertest) + helpers
openapi.json        contrato versionado
docker/compose.yml  infra local
```

Cada módulo segue: `dto/` · `*.controller.ts` · `*.service.ts` ·
`*.repository.ts` · `*.module.ts` · `*.spec.ts`. Um módulo importa o **service**
de outro, nunca o repositório.

---

## Convenções de API

- **Envelope de erro único** (montado só pelo `HttpExceptionFilter`):

  ```json
  {
    "statusCode": 422,
    "code": "VALIDATION_ERROR",
    "message": "Dados inválidos",
    "fieldErrors": { "title": "Título obrigatório" },
    "requestId": "01a0..."
  }
  ```

- **Auth:** access token JWT curto no corpo; refresh token em cookie `httpOnly`
  com rotação e **detecção de reuso** (refresh reusado revoga a família).
  Argon2id nas senhas. Mensagem genérica e tempo comparável no login (RN-02).
  Papel sempre do token, nunca do corpo (RN-03).
- **Rate limit:** `/auth/login` e recuperação de senha, por **IP** (throttler) e
  por **identificador** (contador no Redis).
- **Idempotência:** header `Idempotency-Key` (mutações), resultado guardado no
  Redis — recarregar não duplica efeito.
- **Paginação:** cursor único — `?limit=&cursor=`, resposta `{ data, nextCursor }`.
- **Auditoria:** `AuditInterceptor` grava autor, ação, antes/depois, IP e
  requestId desde já.
- `/health` verifica banco, Redis e storage.

---

## Testes

- **Unidade** (Vitest): `src/**/*.spec.ts`.
- **e2e** (Supertest): `test/**/*.e2e-spec.ts`, contra o banco separado
  `orbitplay_test` (criado, migrado e semeado automaticamente antes da suíte).
  Requer a infra do Docker no ar.

```bash
pnpm test
pnpm test:e2e
```

---

## Portas & adaptadores

| Porta                | Adaptador agora               | Depois          |
| -------------------- | ----------------------------- | --------------- |
| `StoragePort`        | **MinIO** (protocolo S3)      | MinIO próprio   |
| `NotificationPort`   | Mailhog (SMTP)                | provedor e-mail |
| `TelemetryStorePort` | Postgres (`telemetry_events`) | ClickHouse      |
| `PaymentPort`        | `FakePaymentAdapter`          | PSP nacional    |
| `AiPort`             | `StubAiAdapter`               | LLM real        |
| `AsrPort`            | `StubAsrAdapter`              | Whisper         |

Storage é **MinIO em todos os ambientes** (fala o protocolo S3). O SDK
`@aws-sdk/client-s3` é só o cliente do protocolo — por isso as variáveis usam
prefixo `STORAGE_`, não `S3_`, e `forcePathStyle` fica ligado.

---

Veja `DECISIONS.md` para as decisões bloqueantes da seção 1 e desvios com motivo.
