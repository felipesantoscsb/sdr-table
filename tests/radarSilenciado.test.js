// O funil do Radar esta sendo testado puro: a pagina vende sozinha, sem a
// Karina abrindo conversa com quem acabou de responder o quiz. Sem isto nao da
// para separar venda da pagina de venda do atendimento.
//
// O portao vive na ENTRADA do SDR de proposito. A string de origem varia
// conforme quem posta (chegou `radar_table_rota_a`, que nao existe em nenhum
// dos tres repos), entao filtrar na origem do envio deixaria caminho aberto.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

process.env.ANTHROPIC_API_KEY ||= 'test';
process.env.ZAPI_INSTANCE_ID  ||= 'test';
process.env.ZAPI_TOKEN        ||= 'test';
process.env.ZAPI_CLIENT_TOKEN ||= 'test';
process.env.SDR_PHONE         ||= '5511999999999';
process.env.WEBHOOK_SECRET    ||= 'test';

// Dinamico: o import estatico subiria acima das variaveis acima e o config
// derrubaria o arquivo inteiro antes do primeiro teste rodar.
const { ehQuizDoRadar, sdrDoRadarLigado } = await import('../src/webhook/makeHandler.js');
const src = readFileSync(join(root, 'src/webhook/makeHandler.js'), 'utf8');

test('reconhece o quiz do Radar em qualquer grafia da origem', () => {
  const origens = [
    { source: 'radar_table_rota_a' },   // a que chegou de verdade em 22/10
    { source: 'radar_table_rota_b' },
    { source: 'radar_table_rota_c' },
    { source: 'raiz-radar' },
    { slug: 'raiz-radar' },
    { origin: 'Radar Table' },
    { event_source_url: 'https://www.evelynliu.com.br/raiz-radar' },
    { utm: { campaign: 'raiz-radar-06' } },
  ];
  for (const o of origens) assert.equal(ehQuizDoRadar(o), true, JSON.stringify(o));
});

test('a pre-consulta NAO e silenciada', () => {
  // Ali a lead pediu para ser contatada. Nao responder seria quebrar entrega,
  // nao preservar teste.
  assert.equal(ehQuizDoRadar({ source: 'radar_table_pre_consulta' }), false);
  assert.equal(ehQuizDoRadar({ source: 'radar_table_pre-consulta', origin: 'Radar Table' }), false);
});

test('nao pega lead de outro funil', () => {
  for (const o of [{ source: 'quiz_evelynliu' }, { source: 'raiz-v2' }, { source: 'formulario_captacao_table_clinic' }, {}]) {
    assert.equal(ehQuizDoRadar(o), false, JSON.stringify(o));
  }
});

test('religa por variavel de ambiente, sem deploy', () => {
  const antes = process.env.RADAR_SDR_ATIVO;
  try {
    delete process.env.RADAR_SDR_ATIVO;
    assert.equal(sdrDoRadarLigado(), false, 'ausente tem de significar silenciado');
    process.env.RADAR_SDR_ATIVO = 'false';
    assert.equal(sdrDoRadarLigado(), false);
    process.env.RADAR_SDR_ATIVO = 'true';
    assert.equal(sdrDoRadarLigado(), true);
    process.env.RADAR_SDR_ATIVO = 'TRUE';
    assert.equal(sdrDoRadarLigado(), true, 'maiuscula tem de valer');
    process.env.RADAR_SDR_ATIVO = '1';
    assert.equal(sdrDoRadarLigado(), false, 'so "true" liga, para nao religar por acidente');
  } finally {
    if (antes === undefined) delete process.env.RADAR_SDR_ATIVO; else process.env.RADAR_SDR_ATIVO = antes;
  }
});

test('o portao vem antes da ativacao, responde 200 e registra no Hub', () => {
  assert.match(src, /reason: 'radar_sdr_silenciado'/);
  assert.match(src, /ehQuizDoRadar\(leadData\) && !sdrDoRadarLigado\(\)/);
  // Ativar ja agenda o primeiro contato: depois da ativacao o portao chegaria tarde.
  assert.ok(src.indexOf('radar_sdr_silenciado') < src.indexOf('const activation = await validateAndActivateLead'),
    'o portao esta depois da ativacao — a mensagem ja teria saido');
  // Silenciar o atendimento nao pode perder a lead.
  assert.match(src, /radar_sdr_silenciado[\s\S]{0,500}garantirLeadCaptacaoNoHub/);
  // 200 para o aquisicao-table nao reenviar pelo drain.
  assert.match(src, /status\(200\)\.json\(\{ received: true, activated: false, phone, reason: 'radar_sdr_silenciado' \}\)/);
});
