import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { diagnosticoInbound } from '../src/inbound/diagnostico.js';

const fonte = readFileSync(new URL('../src/inbound/diagnostico.js', import.meta.url), 'utf8');

test('o diagnostico nao vaza telefone nem texto por padrao', async () => {
  // Sem Redis alcancavel o scan devolve vazio; o que importa aqui e o
  // contrato: amostras so saem quando pedidas, e nunca com telefone inteiro.
  const r = await diagnosticoInbound({});
  assert.deepEqual(r.amostras, [], 'amostra tem de ser opt-in');
  assert.ok('chaves_conv' in r, 'precisa distinguir Redis mudo de zero conversas');
});

test('o teto de amostras e aplicado no handler, nao no chamador', async () => {
  assert.match(fonte, /Math\.min\(Number\(req\.body\?\.amostras\) \|\| 0, 20\)/);
  assert.match(fonte, /x-webhook-secret/);
  assert.match(fonte, /return res\.status\(401\)/);
});

test('o telefone sai sempre mascarado', async () => {
  assert.match(fonte, /function mascarar/);
  assert.match(fonte, /telefone: mascarar\(/);
  // leadData carrega nome e telefone cru: nao pode entrar na amostra.
  assert.doesNotMatch(fonte, /leadData[^\n]*amostras|amostras[^\n]*leadData/);
});

test('o funil mede degraus em ordem, para achar o que derruba', async () => {
  for (const degrau of ['iniciou', 'respondeu', 'qualificou', 'recebeu_oferta', 'deu_disponibilidade', 'handoff']) {
    assert.ok(fonte.includes(degrau), `degrau ${degrau} ausente`);
  }
  assert.match(fonte, /b\.queda\[/, 'a queda entre degraus e o que responde a pergunta');
  assert.match(fonte, /function calcularQueda/);
});

test('o corte divide em antes e depois, com a mesma forma dos dois lados', async () => {
  const { CORTE_PADRAO } = await import('../src/inbound/diagnostico.js');
  const r = await diagnosticoInbound({ corte: CORTE_PADRAO });
  assert.ok(r.antes && r.depois, 'faltou um dos lados');
  assert.deepEqual(Object.keys(r.antes).sort(), Object.keys(r.depois).sort());
  assert.ok(r.antes.queda && r.depois.queda, 'cada lado precisa da propria queda');
  assert.equal(r.corte, CORTE_PADRAO);
});

test('conversa sem data nao e empurrada para um dos lados', async () => {
  // `iniciadoEm` so existe desde 16/10/2026. Somar as antigas a um dos lados
  // inventaria resultado; elas saem em `sem_data` e aparecem no total.
  assert.match(fonte, /r\.sem_data\+\+; continue;/);
  assert.match(fonte, /sem_data: 0/);
  assert.doesNotMatch(fonte, /nasceu \|\| limite/, 'nao pode ter fallback de data');
});

test('sem corte, a forma antiga continua valendo', async () => {
  const r = await diagnosticoInbound({});
  assert.ok(r.funil && r.queda, 'o modo plano nao pode quebrar');
  assert.equal(r.antes, undefined);
});

test('corte invalido falha alto, em vez de virar zero', async () => {
  await assert.rejects(() => diagnosticoInbound({ corte: 'ontem' }), /ISO 8601/);
});

test('o corte padrao e o deploy do prompt novo', async () => {
  const { CORTE_PADRAO } = await import('../src/inbound/diagnostico.js');
  assert.equal(CORTE_PADRAO, '2026-10-19T16:14:00-03:00');
  // Pedir `corte: false` volta ao total, sem divisao.
  assert.match(fonte, /req\.body\?\.corte === false \? null/);
});
