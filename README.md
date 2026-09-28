# SDR WhatsApp Automatizado

Sistema de SDR automático que combina Make + Anthropic + Zapi para qualificar e
abordar leads via WhatsApp com IA, mantendo a SDR humana no loop.

## Arquitetura

```
Make (CRM/planilha)
    │
    │ POST /webhook/lead (dados do lead)
    ▼
[Servidor Node.js]
    │
    ├─→ Anthropic API (gera mensagem + briefing)
    │
    ├─→ Zapi → Lead (primeira mensagem)
    │
    └─→ Zapi → SDR (briefing + link wa.me + sugestão)

Lead responde no WhatsApp
    │
    │ POST /webhook/zapi (mensagem recebida)
    ▼
[Aggregator 30s] ← aguarda mais mensagens
    │
    ├─→ Anthropic API (gera resposta contextualizada)
    ├─→ Zapi → Lead (resposta)
    └─→ Zapi → SDR (update da conversa)
```

## Setup

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
# Edite o .env com suas chaves
```

### 3. Rodar localmente
```bash
npm run dev
```

### 4. Expor para internet (desenvolvimento)
```bash
npx ngrok http 3000
# Copie a URL https://xxxx.ngrok.io
```

### 5. Configurar Make
- Módulo: HTTP > Make a Request
- URL: `https://sua-url.ngrok.io/webhook/lead`
- Método: POST
- Body type: JSON
- Headers: `x-webhook-secret: sua-senha-secreta`
- Campos: Nome, WhatsApp, Temperatura, Score, O que mais pesa, Histórico, Saúde, Comprometimento, Maior dificuldade

### 6. Configurar Zapi
- Painel Zapi → Sua instância → Webhooks
- "On Message Received": `https://sua-url.ngrok.io/webhook/zapi`

## Estrutura de arquivos

```
sdr-whatsapp/
├── config/
│   └── index.js          # Todas as configurações centralizadas
├── src/
│   ├── index.js           # Servidor Express (entrada)
│   ├── webhook/
│   │   ├── makeHandler.js # Processa leads vindos do Make
│   │   └── zapiHandler.js # Processa respostas dos leads
│   ├── ai/
│   │   └── anthropic.js   # Integração com a API da Anthropic
│   ├── zapi/
│   │   └── sender.js      # Envio de mensagens via Zapi
│   └── conversation/
│       ├── store.js        # Histórico de conversas (por número)
│       └── aggregator.js   # Timer de 30s para agregar mensagens
├── .env.example
└── package.json
```

## Em produção

- Substitua o `store.js` por Redis (histórico persiste entre restarts)
- Use PM2 para manter o processo rodando: `pm2 start src/index.js`
- Configure um domínio fixo (não ngrok)
- Adicione rate limiting para proteger os endpoints

## Cadência pós-quiz oficial

O webhook `POST /webhook/quiz` mantém o envio existente do dossiê em cerca de
15 minutos e agenda, no mesmo Redis e job já usados pelo serviço, três passos
ancorados no horário do `QuizCompleted`:

- D+1: template aprovado `d1_pr`;
- D+3: template aprovado `d3_pr`;
- D+5: template aprovado `d5_pr`.

A cadência fica ativa diretamente no código, sem depender de flag de ambiente.

Cada template recebe somente o primeiro nome. Antes de cada envio, o serviço
confere compra no Redis, veto definitivo no Hub e opt-out. Locks e marcadores de
envio impedem concorrência e reenvio. O `lead_event_id` identifica a ocorrência
do quiz, portanto o mesmo `QuizCompleted` não cria outra cadência.

Cadências persistidas por versões anteriores são descartadas e não entram em
backfill. Para QA, configure temporariamente
`QUIZ_CADENCE_D1_DELAY_MS=60000`, `QUIZ_CADENCE_D3_DELAY_MS=120000` e
`QUIZ_CADENCE_D5_DELAY_MS=180000`. O job varre a fila a cada minuto; não use
esses overrides em produção.
