// Reporte do funil do inbound e backfill.
//
// O que estes testes protegem: o event_id tem de ser DETERMINÍSTICO (id
// aleatório faria um reenvio por rede virar uma segunda lead no funil), e a
// telemetria nunca pode derrubar uma conversa com lead real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (f) => readFileSync(join(root, f), 'utf8');

process.env.ANTHROPIC_API_KEY ||= 'test';
process.env.ZAPI_INSTANCE_ID  ||= 'test';
process.env.ZAPI_TOKEN        ||= 'test';
process.env.ZAPI_CLIENT_TOKEN ||= 'test';
process.env.SDR_PHONE         ||= '5511999999999';
process.env.WEBHOOK_SECRET    ||= 'test';

const { eventIdDe, registrarEtapa } = await import('../src/inbound/funil.js');

test('o event_id é determinístico: mesma lead e etapa, mesmo id', () => {
  // Com id aleatório, um reenvio por falha de rede viraria um SEGUNDO evento e
  // o funil contaria a mesma lead duas vezes.
  assert.equal(eventIdDe('5511988887777', 'qualificada'), eventIdDe('5511988887777', 'qualificada'));
  // E tolera formatação diferente do mesmo número.
  assert.equal(eventIdDe('+55 11 98888-7777', 'handoff'), eventIdDe('5511988887777', 'handoff'));
  // Etapas diferentes não colidem.
  assert.notEqual(eventIdDe('5511988887777', 'handoff'), eventIdDe('5511988887777', 'qualificada'));
});

test('sem segredo do Hub, reportar falha em silêncio e devolve false', async () => {
  const antes = process.env.HUB_WEBHOOK_SECRET;
  const antes2 = process.env.INTERNAL_WEBHOOK_SECRET;
  delete process.env.HUB_WEBHOOK_SECRET;
  delete process.env.INTERNAL_WEBHOOK_SECRET;
  try {
    // Precisa reimportar: o segredo é lido na carga do módulo.
    const mod = await import('../src/inbound/funil.js?semsegredo');
    assert.equal(await mod.registrarEtapa({ phone: '5511988887777', tipo: 'qualificada' }), false);
  } finally {
    if (antes) process.env.HUB_WEBHOOK_SECRET = antes;
    if (antes2) process.env.INTERNAL_WEBHOOK_SECRET = antes2;
  }
});

test('reportar NUNCA lança, mesmo com o Hub inalcançável', async () => {
  process.env.HUB_WEBHOOK_SECRET = 'teste';
  process.env.HUB_INBOUND_EVENT_URL = 'http://127.0.0.1:1/nao-existe';
  try {
    const mod = await import('../src/inbound/funil.js?inalcancavel');
    assert.equal(await mod.registrarEtapa({ phone: '5511988887777', tipo: 'handoff' }), false);
  } finally {
    delete process.env.HUB_INBOUND_EVENT_URL;
  }
});

test('telemetria não bloqueia a conversa: as chamadas não são aguardadas', () => {
  const h = ler('src/inbound/handler.js');
  const chamadas = h.match(/registrarEtapa\(\{/g) || [];
  assert.ok(chamadas.length >= 5, `só ${chamadas.length} etapas reportadas`);
  assert.ok(!/await registrarEtapa\(/.test(h),
    'etapa aguardada: uma conversa com lead real não pode esperar o relatório');
});

test('qualificada usa o gatilho de código, não a opinião do modelo', () => {
  // É o MESMO campo que libera o handoff. Se divergirem, o relatório conta uma
  // coisa e o gate faz outra.
  const h = ler('src/inbound/handler.js');
  assert.match(h, /r\.qualificacao\?\.completa && !estado\.qualificacao\?\.completa/);
});

test('as cinco etapas do agente estão cobertas', () => {
  const h = ler('src/inbound/handler.js');
  for (const t of ['conversa_iniciada', 'primeira_resposta', 'qualificada', 'handoff', 'desqualificada']) {
    assert.ok(h.includes(`tipo: '${t}'`), `etapa não reportada: ${t}`);
  }
});

test('o backfill é seguro de rodar duas vezes e tem modo de simulação', () => {
  const b = ler('src/inbound/backfill.js');
  // Reusa o mesmo event_id determinístico; a repetição morre no ON CONFLICT.
  assert.match(b, /registrarEtapa/);
  assert.match(b, /dryRun/);
  // Só conversas do inbound entram — nem recovery, nem reativação, nem SDR.
  assert.match(b, /conv\.mode !== 'inbound'/);
  // E o endpoint é protegido pelo mesmo segredo interno dos outros webhooks.
  assert.match(b, /x-webhook-secret/);
  assert.match(b, /status\(401\)/);
});

test('o backfill infere handoff DE AGENDAMENTO, não marca tudo igual', () => {
  // Só 'pronta_para_agendar' conta no passo da Karina. Marcar todo handoff
  // igual inflaria o denominador dela com quem pediu a Evelyn ou perguntou
  // algo fora do roteiro.
  const b = ler('src/inbound/backfill.js');
  assert.match(b, /pronta_para_agendar/);
  assert.match(b, /backfill_outro_motivo/);
  // A inferência usa o mesmo sinal que o gate exige: turnos e dias, ou o
  // texto da disponibilidade no caminho da válvula.
  assert.match(b, /d\.turnos\?\.length && d\.dias\?\.length/);
  assert.match(b, /d\.texto/);
});

test('o backfill admite o próprio limite por escrito', () => {
  // Reconstruir do estado final dá volume, não ritmo: dá para saber que a lead
  // qualificou, não quando.
  const b = ler('src/inbound/backfill.js');
  assert.match(b, /não QUANDO|nao QUANDO/);
});
