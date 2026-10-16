import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.QUIZ_CADENCE_ENABLED = 'true';

const {
  QUIZ_CADENCE_STEPS,
  QUIZ_CADENCE_VERSION,
  scheduleQuizCadence,
  fireQuizCadenceStep,
  checkQuizCadence,
  setQuizCadenceTestDependencies,
  resetQuizCadenceTestDependencies,
} = await import('../src/quizCadence.js');

function createHarness() {
  const values = new Map();
  const sent = [];
  const registered = [];
  let blocked = false;
  let eligibility = { allowed: true, reason: null };

  const safeGet = async (key) => values.get(key) ?? null;
  const safeSet = async (key, value, ...args) => {
    if (args.includes('NX') && values.has(key)) return null;
    values.set(key, String(value));
    return 'OK';
  };
  const safeDel = async (key) => values.delete(key) ? 1 : 0;
  const safeKeys = async (pattern) => {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    return [...values.keys()].filter(key => pattern.endsWith('*') ? key.startsWith(prefix) : key === pattern);
  };

  setQuizCadenceTestDependencies({
    safeGet,
    safeSet,
    safeDel,
    safeKeys,
    isBlocked: async () => blocked,
    verificarElegibilidadeContatoSdr: async () => eligibility,
    bloqueioDefinitivoSdr: result => !result?.allowed && ['patient', 'converted_or_won'].includes(result?.reason),
    sendOfficialTemplate: async payload => {
      sent.push(payload);
      return { messages: [{ id: `wamid.${sent.length}` }] };
    },
    registrarTemplateWhatsApp: async payload => {
      registered.push(payload);
      return { ok: true };
    },
  });

  return {
    values,
    sent,
    registered,
    setBlocked(value) { blocked = value; },
    setEligibility(value) { eligibility = value; },
  };
}

function lead(overrides = {}) {
  return {
    nome: 'Maria da Silva',
    phone: '5511999999999',
    perfil: 'E',
    lead_event_id: 'quiz-event-123',
    timestamp: 1_800_000_000_000,
    source: 'quiz',
    ...overrides,
  };
}

afterEach(() => resetQuizCadenceTestDependencies());

test('agenda D+1 a partir do QuizCompleted e envia o template aprovado', async () => {
  const h = createHarness();
  const input = lead();
  const cadence = await scheduleQuizCadence(input.phone, input);

  assert.equal(cadence.version, QUIZ_CADENCE_VERSION);
  assert.deepEqual(cadence.steps.map(step => step.templateName), ['d1_pr']);
  assert.deepEqual(
    cadence.steps.map(step => step.fire_at),
    QUIZ_CADENCE_STEPS.map(step => input.timestamp + step.delayMs)
  );

  await fireQuizCadenceStep(input.phone, 0);

  assert.deepEqual(h.sent.map(item => item.templateName), ['d1_pr']);
  assert.ok(h.sent.every(item => item.params.length === 1 && item.params[0] === 'Maria'));
  assert.deepEqual(h.registered.map(item => item.templateName), ['d1_pr']);
});

// O risco real de tirar o D+3 não é o agendamento novo: é quem já estava no
// meio da cadência quando o passo saiu. A versão não foi bumpada de propósito
// (bumpar descartaria também o D+1 em voo), então a pendência de índice 1
// sobrevive ao filtro de versão e precisa morrer no ramo `if (!step)`.
test('pendência de D+3 já agendada não dispara nada e some', async () => {
  const h = createHarness();
  const input = lead();
  await scheduleQuizCadence(input.phone, input);

  // Simula a pendência que ficou de antes do corte.
  const chave = `pending_quiz_cadence:${input.phone}:1`;
  h.values.set(chave, JSON.stringify({
    version: QUIZ_CADENCE_VERSION, phone: input.phone, stepIndex: 1,
    fire_at: input.timestamp + 3 * 24 * 60 * 60 * 1000,
  }));

  await fireQuizCadenceStep(input.phone, 1);

  assert.equal(h.sent.length, 0, 'D+3 não pode mais sair');
  assert.ok(!h.values.has(chave), 'a chave tem de ser apagada, senão o sweep volta nela a cada minuto');
});

test('compra antes de D+1 cancela todos os envios', async () => {
  const h = createHarness();
  const input = lead();
  await scheduleQuizCadence(input.phone, input);
  h.values.set(`compra:${input.phone}`, '1');

  await fireQuizCadenceStep(input.phone, 0);

  assert.equal(h.sent.length, 0);
  assert.equal(h.values.get(`quiz_cadence_cancelled:${input.phone}`), 'purchase');
  assert.equal([...h.values.keys()].filter(key => key.startsWith(`pending_quiz_cadence:${input.phone}:`)).length, 0);
});

test('compra depois do D+1 não deixa nenhum passo residual disparar', async () => {
  const h = createHarness();
  const input = lead();
  await scheduleQuizCadence(input.phone, input);
  await fireQuizCadenceStep(input.phone, 0);
  h.values.set(`compra:${input.phone}`, '1');

  await fireQuizCadenceStep(input.phone, 1);
  await fireQuizCadenceStep(input.phone, 2);

  assert.deepEqual(h.sent.map(item => item.templateName), ['d1_pr']);
});

test('QuizCompleted duplicado não reinicia a cadência nem apaga etapas enviadas', async () => {
  const h = createHarness();
  const input = lead();
  const original = await scheduleQuizCadence(input.phone, input);
  await fireQuizCadenceStep(input.phone, 0);

  const duplicate = await scheduleQuizCadence(input.phone, { ...input, timestamp: input.timestamp + 999_999 });
  await fireQuizCadenceStep(input.phone, 0);

  assert.equal(duplicate.quiz_completed_at, original.quiz_completed_at);
  assert.equal(h.sent.length, 1);
  assert.equal(h.values.get(`quiz_cadence_sent:${input.phone}:d1`), '1');
});

test('etapa já enviada não é reenviada', async () => {
  const h = createHarness();
  const input = lead();
  await scheduleQuizCadence(input.phone, input);

  await fireQuizCadenceStep(input.phone, 0);
  await fireQuizCadenceStep(input.phone, 0);

  assert.deepEqual(h.sent.map(item => item.templateName), ['d1_pr']);
});

test('venda confirmada no Hub e opt-out também encerram a sequência', async () => {
  const converted = createHarness();
  const input = lead();
  await scheduleQuizCadence(input.phone, input);
  converted.setEligibility({ allowed: false, reason: 'converted_or_won' });
  await fireQuizCadenceStep(input.phone, 0);
  assert.equal(converted.sent.length, 0);
  assert.equal(converted.values.get(`quiz_cadence_cancelled:${input.phone}`), 'converted_or_won');

  const optedOut = createHarness();
  const second = lead({ phone: '5511888888888', lead_event_id: 'quiz-event-456' });
  await scheduleQuizCadence(second.phone, second);
  optedOut.setBlocked(true);
  await fireQuizCadenceStep(second.phone, 0);
  assert.equal(optedOut.sent.length, 0);
  assert.equal(optedOut.values.get(`quiz_cadence_cancelled:${second.phone}`), 'blocked');
});

test('pendências de versões anteriores são descartadas sem backfill', async () => {
  const h = createHarness();
  const phone = '5511777777777';
  h.values.set(`pending_quiz_cadence:${phone}:0`, JSON.stringify({ phone, stepIndex: 0, fire_at: 1, version: 'legacy' }));

  await checkQuizCadence();

  assert.equal(h.values.has(`pending_quiz_cadence:${phone}:0`), false);
  assert.equal(h.sent.length, 0);
});

// Os prazos eram configuráveis por env. O risco prático era uma variável de QA
// esquecida no Railway: com QUIZ_CADENCE_D1_DELAY_MS=60000 os três disparos
// sairiam em menos de 3 minutos do quiz, na mesma pessoa.
test('os prazos são fixos e não voltam a depender de variável de ambiente', () => {
  const fonte = readFileSync(new URL('../src/quizCadence.js', import.meta.url), 'utf8');
  // Trava o USO, não a menção: o comentário no código cita o nome da variável
  // de propósito, para quem for mexer entender por que ela saiu.
  assert.doesNotMatch(fonte, /process\.env\.QUIZ_CADENCE_D[135]_DELAY_MS/);
  assert.doesNotMatch(fonte, /delayMs:\s*Number\(/);
});

// Um toque desde 16/10/2026: três viraram dois em 07/10 e agora só o D+1
// permanece. O teste trava os fatos que custam dinheiro se
// mudarem sem querer — quantos disparos e em que dia.
test('a cadência tem um toque só: D+1', () => {
  const dia = 24 * 60 * 60 * 1000;
  assert.deepEqual(QUIZ_CADENCE_STEPS.map(s => s.delayMs), [1 * dia]);
  assert.deepEqual(QUIZ_CADENCE_STEPS.map(s => s.key), ['d1']);
  assert.deepEqual(QUIZ_CADENCE_STEPS.map(s => s.templateName), ['d1_pr']);
});

// Quem entrou na cadência antes do corte tem uma pendência de D+5 agendada no
// Redis. Ela não pode virar lixo que o sweep revisita de minuto em minuto.
test('pendência do antigo D+5 é descartada em vez de ficar girando', async () => {
  const h = createHarness();
  const input = lead();
  await scheduleQuizCadence(input.phone, input);
  const chaveAntiga = `pending_quiz_cadence:${input.phone}:2`;
  h.values.set(chaveAntiga, JSON.stringify({ version: QUIZ_CADENCE_VERSION, phone: input.phone, stepIndex: 2, fire_at: Date.now() }));

  await fireQuizCadenceStep(input.phone, 2);

  assert.equal(h.sent.length, 0);
  assert.equal(h.values.has(chaveAntiga), false);
});
