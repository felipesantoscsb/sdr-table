// Testes do inbound de WhatsApp (anúncio / story).
//
// Rodam a lógica de verdade, não o texto do arquivo: o que importa aqui é o
// comportamento dos gates, e asserção em cima do código-fonte já passou por
// casar com os próprios comentários mais de uma vez neste projeto.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (f) => readFileSync(join(root, f), 'utf8');

// config/index.js exige essas variáveis no import; o teste não fala com nenhum
// serviço, só precisa que o módulo carregue.
process.env.ANTHROPIC_API_KEY ||= 'test';
process.env.ZAPI_INSTANCE_ID  ||= 'test';
process.env.ZAPI_TOKEN        ||= 'test';
process.env.ZAPI_CLIENT_TOKEN ||= 'test';
process.env.SDR_PHONE         ||= '5511999999999';
process.env.WEBHOOK_SECRET    ||= 'test';

const { detectarEntrada, FRASES } = await import('../src/inbound/entry.js');
const {
  normalizarRespostaInbound, fundirQualificacaoInbound, fundirDisponibilidadeInbound,
} = await import('../src/ai/anthropic.js');

const resp = (obj, qAnt = {}, dAnt = {}) =>
  normalizarRespostaInbound(JSON.stringify(obj), qAnt, dAnt, 0);

// ─── Divisor de tráfego: o risco número um deste fluxo ───────────────────────

test('cada frase pronta casa com a sua própria origem', () => {
  // Invariante que não pode quebrar: se uma frase deixar de casar com a chave
  // dela, a lead ainda é atendida mas entra com a origem errada — e o relatório
  // de origem passa a mentir em silêncio.
  for (const [chave, frase] of Object.entries(FRASES)) {
    assert.equal(detectarEntrada({}, frase).origem, chave, `${chave} casou errado`);
  }
  assert.deepEqual(
    Object.keys(FRASES).sort(),
    ['anuncio', 'bio', 'blog', 'site', 'story', 'tiktok'],
    'origem nova precisa de frase pronta e de link atualizado na superfície'
  );
});

test('resposta de pesquisa de satisfação NUNCA abre conversa de captação', () => {
  // A instância é a mesma: paciente respondendo pesquisa chega no mesmo webhook
  // que lead de anúncio. Confundir as duas é o pior resultado possível.
  const respostas = [
    'Nota 10, adorei o atendimento!',
    'obrigada!',
    '9',
    'Oi, já preenchi o formulário sim',
    'Achei ótimo o acompanhamento, recomendo',
    'quero saber mais sobre a minha consulta',
    'Oi! Tudo bem? Queria saber sobre a Table',
  ];
  for (const r of respostas) {
    assert.equal(detectarEntrada({}, r).match, false, `abriu conversa por engano: "${r}"`);
  }
});

test('frase aguenta acento, caixa, pontuação e saudação colada', () => {
  const variantes = [
    'oi vim pelo anuncio e quero saber mais sobre o acompanhamento da table clinic',
    'Oi!! Vim pelo ANÚNCIO e quero saber mais sobre o acompanhamento da Table Clinic!!!',
    'Bom dia, tudo bem? Oi! Vim pelo anúncio e quero saber mais sobre o acompanhamento da Table Clinic 😊',
  ];
  for (const v of variantes) {
    const d = detectarEntrada({}, v);
    assert.equal(d.match, true, `não casou: "${v}"`);
    assert.equal(d.origem, 'anuncio');
  }
});

test('click-to-WhatsApp sem a frase entra pelo referral, marcado como tal', () => {
  const d = detectarEntrada({ referral: { sourceId: '120210', headline: 'Teste' } }, 'oi');
  assert.equal(d.match, true);
  assert.equal(d.origem, 'anuncio');
  assert.equal(d.viaReferral, true, 'precisa ser marcado para poder ser desligado');
  assert.equal(d.ctwa.sourceId, '120210');
});

// ─── Gate de handoff: a Karina não pode ligar sem saber a disponibilidade ────

const QUALIFICADA = {
  padrao: 'escape',
  tentativas: ['dieta', 'nutri'],
  dor_texto: 'Como escondido de noite depois que todo mundo dorme, e no outro dia me odeio',
  saude: ['hipo'],
  prontidao: 'alta',
};

test('handoff de agendamento é RECUSADO sem turnos e dias', () => {
  const r = resp({
    leadMessage: 'vou te passar pra Karina', qualificacao: QUALIFICADA,
    disponibilidade: { turnos: [], dias: [] }, handoff: true, handoffMotivo: 'pronta_para_agendar',
  });
  assert.equal(r.handoff, false, 'passou sem disponibilidade');
  assert.equal(r.handoffMotivo, '');
});

test('só turno, sem dias, ainda não passa', () => {
  const r = resp({
    leadMessage: 'ok', qualificacao: QUALIFICADA,
    disponibilidade: { turnos: ['manha'], dias: [] }, handoff: true,
  });
  assert.equal(r.handoff, false);
});

test('com turnos E dias, o handoff passa e é rotulado como agendamento', () => {
  const r = resp({
    leadMessage: 'Nossa secretária vai te chamar de outro número', qualificacao: QUALIFICADA,
    disponibilidade: { turnos: ['manha', 'tarde'], dias: ['ter', 'qui'] },
    handoff: true, handoffMotivo: 'pronta_para_agendar',
  });
  assert.equal(r.handoff, true);
  assert.equal(r.handoffMotivo, 'pronta_para_agendar');
  assert.deepEqual(r.disponibilidade.turnos, ['manha', 'tarde']);
  assert.deepEqual(r.disponibilidade.dias, ['ter', 'qui']);
});

test('motivos que não são agenda passam sem disponibilidade', () => {
  for (const motivo of ['pediu_evelyn', 'pediu_humano', 'fora_do_roteiro', 'ja_paciente']) {
    const r = resp({
      leadMessage: 'vou chamar a equipe', qualificacao: {},
      disponibilidade: { turnos: [], dias: [] }, handoff: true, handoffMotivo: motivo,
    });
    assert.equal(r.handoff, true, `${motivo} foi barrado indevidamente`);
    assert.equal(r.handoffMotivo, motivo);
  }
});

test('disponibilidade acumula entre rodadas: turno numa, dias na outra', () => {
  const r1 = resp({ leadMessage: 'e quais dias?', qualificacao: QUALIFICADA,
    disponibilidade: { turnos: ['noite'], dias: [] } });
  assert.equal(r1.handoff, false);

  const r2 = resp(
    { leadMessage: 'fechado', qualificacao: {}, disponibilidade: { dias: ['seg'] }, handoff: true },
    r1.qualificacao, r1.disponibilidade
  );
  assert.deepEqual(r2.disponibilidade.turnos, ['noite'], 'perdeu o turno da rodada anterior');
  assert.equal(r2.handoff, true);
});

// ─── Estado cumulativo: informação que a pessoa deu não pode evaporar ───────

test('campo omitido pelo modelo não apaga o que a pessoa já contou', () => {
  const r = resp({ leadMessage: 'entendi', qualificacao: {} }, QUALIFICADA, {});
  assert.equal(r.qualificacao.padrao, 'escape');
  assert.deepEqual(r.qualificacao.tentativas, ['dieta', 'nutri']);
  assert.match(r.qualificacao.dor_texto, /escondido de noite/);
  assert.equal(r.qualificacao.prontidao, 'alta');
});

test('relato longo não é substituído por resumo curto na rodada seguinte', () => {
  const r = resp({ leadMessage: 'ok', qualificacao: { dor_texto: 'ansiedade' } }, QUALIFICADA, {});
  assert.match(r.qualificacao.dor_texto, /escondido de noite/);
});

test('tentativas e condições se somam, sem repetir', () => {
  const q = fundirQualificacaoInbound(
    { tentativas: ['dieta'], saude: ['hipo'] },
    { tentativas: ['dieta', 'jejum'], saude: ['ansiedade'] }
  );
  assert.deepEqual(q.tentativas, ['dieta', 'jejum']);
  assert.deepEqual(q.saude, ['hipo', 'ansiedade']);
});

test('`completa` é calculada no código e ignora o que o modelo afirma', () => {
  const mentindo = resp({
    leadMessage: 'ok',
    qualificacao: { completa: true, padrao: 'nao_informado', tentativas: [], dor_texto: '' },
  });
  assert.equal(mentindo.qualificacao.completa, false);

  const real = resp({ leadMessage: 'ok', qualificacao: QUALIFICADA });
  assert.equal(real.qualificacao.completa, true);
});

test('dor genérica de uma palavra não conta como qualificação completa', () => {
  const r = resp({
    leadMessage: 'ok',
    qualificacao: { padrao: 'rotina', tentativas: ['dieta'], dor_texto: 'quero emagrecer' },
  });
  assert.equal(r.qualificacao.completa, false, '"quero emagrecer" não é relato');
});

// ─── Sanidade dos dados que vão para o card e o relatório ───────────────────

test('valor fora do vocabulário é descartado, não propagado', () => {
  const r = resp({
    leadMessage: 'ok',
    qualificacao: {
      padrao: 'inventado', tentativas: ['dieta', 'ayahuasca'],
      saude: ['hipo', 'lombriga'], prontidao: 'altíssima',
    },
  });
  assert.equal(r.qualificacao.padrao, 'nao_informado');
  assert.deepEqual(r.qualificacao.tentativas, ['dieta']);
  assert.deepEqual(r.qualificacao.saude, ['hipo']);
  assert.equal(r.qualificacao.prontidao, 'nao_informado');
});

// 16/10/2026: o primeiro handoff real travou aqui. A lead disse "qualquer dia
// de seg a sex a noite" — disponibilidade completa — e o agente continuou
// pedindo dia. Causa: eu documentei no prompt os valores de `turnos` e esqueci
// os de `dias`, então o modelo escrevia português natural e o whitelist
// descartava tudo em silêncio.
test('a lead fala como gente, e isso tem de virar dias válidos', () => {
  const casos = [
    ['qualquer dia de seg a sex', ['seg', 'ter', 'qua', 'qui', 'sex']],
    ['de segunda a sexta',        ['seg', 'ter', 'qua', 'qui', 'sex']],
    ['seg-sex',                   ['seg', 'ter', 'qua', 'qui', 'sex']],
    ['segunda',                   ['seg']],
    ['terça-feira',               ['ter']],
    ['sabado',                    ['sab']],
    ['qualquer dia',              ['qualquer']],
    ['tanto faz',                 ['qualquer']],
  ];
  for (const [entrada, esperado] of casos) {
    const d = fundirDisponibilidadeInbound({}, { dias: [entrada] });
    assert.deepEqual(d.dias, esperado, `"${entrada}" virou ${JSON.stringify(d.dias)}`);
  }
});

test('turnos também aceitam a forma falada', () => {
  for (const [entrada, esperado] of [['à noite', 'noite'], ['de manhã', 'manha'],
                                      ['pela tarde', 'tarde'], ['qualquer horário', 'qualquer']]) {
    const d = fundirDisponibilidadeInbound({}, { turnos: [entrada] });
    assert.deepEqual(d.turnos, [esperado], `"${entrada}" virou ${JSON.stringify(d.turnos)}`);
  }
});

test('intervalo vence o sinônimo solto dentro da mesma frase', () => {
  // "qualquer dia de seg a sex" contém "qualquer" E uma faixa. A faixa é mais
  // específica e não pode ser engolida.
  const d = fundirDisponibilidadeInbound({}, { dias: ['qualquer dia de seg a sex'] });
  assert.equal(d.dias.length, 5);
  assert.ok(!d.dias.includes('qualquer'));
});

test('disponibilidade só em texto livre libera o handoff, não prende a lead', () => {
  // O gate existe para a Karina não ligar sem saber quando. Se a lead DISSE
  // quando pode e só a estruturação falhou, segurar é pior que passar com as
  // palavras dela.
  const q = { padrao: 'escape', tentativas: ['dieta'], prontidao: 'alta',
    dor_texto: 'Como escondido a noite e no outro dia me odeio demais' };
  const r = resp({ leadMessage: 'ok', qualificacao: q, handoff: true,
    handoffMotivo: 'pronta_para_agendar',
    disponibilidade: { turnos: [], dias: [], texto: 'consigo nas quartas depois das 18h' } });
  assert.equal(r.handoff, true);
  assert.equal(r.disponibilidadeNaoEstruturada, true, 'a Karina precisa saber que veio solto');

  // Sem nada em lugar nenhum, continua barrado.
  const vazio = resp({ leadMessage: 'ok', qualificacao: q, handoff: true,
    disponibilidade: { turnos: [], dias: [], texto: '' } });
  assert.equal(vazio.handoff, false);
});

test('turno e dia fora do vocabulário não viram agenda', () => {
  const d = fundirDisponibilidadeInbound({}, { turnos: ['madrugada'], dias: ['feriado'] });
  assert.deepEqual(d.turnos, []);
  assert.deepEqual(d.dias, []);
});

test('score e tier saem do estado apurado, não do que o modelo pediu', () => {
  const r = resp({ leadMessage: 'ok', qualificacao: QUALIFICADA, score: 0, tier: 'cold' });
  assert.equal(r.score, 10);
  assert.equal(r.tier, 'hot');

  const fria = resp({ leadMessage: 'ok', qualificacao: { padrao: 'rotina' }, score: 9, tier: 'hot' });
  assert.equal(fria.tier, 'cold');
});

// ─── Falha ───────────────────────────────────────────────────────────────────

test('JSON inválido não gera mensagem: vira handoff técnico', () => {
  const r = normalizarRespostaInbound('desculpa, não consegui', {}, {}, 0);
  assert.equal(r.ok, false);
  assert.equal(r.leadMessage, '', 'não pode enviar texto solto para a lead');
  assert.equal(r.handoff, true);
  assert.equal(r.handoffMotivo, 'erro_tecnico');
});

test('red flag não exige mensagem e não vira oferta', () => {
  const r = resp({ leadMessage: '', redflag: true, redflagMotivo: 'teor suicida' });
  assert.equal(r.redflag, true);
  assert.equal(r.redflagMotivo, 'teor suicida');
});

// ─── Invariantes de segurança do fluxo ──────────────────────────────────────

test('reação é descartada antes de qualquer leitura de estado', () => {
  // A ordem precisa ser medida DENTRO da função, não no arquivo: os mesmos
  // nomes aparecem antes, nos imports.
  const wh = ler('src/webhook/zapiInboundHandler.js');
  const corpo = wh.slice(wh.indexOf('export async function handleZapiInbound'));
  const posReacao = corpo.indexOf('if (ehReacao)');
  assert.ok(posReacao > 0, 'guarda de reação ausente no corpo do handler');
  assert.ok(posReacao < corpo.indexOf('await temConversaInbound'), 'reação lida depois do estado');
  assert.ok(posReacao < corpo.indexOf('detectarEntrada(body'), 'reação lida depois da detecção');
});

test('o inbound nunca envia pela instância da Karina', () => {
  const handler = ler('src/inbound/handler.js');
  // Mensagem para a lead sai só por sendInboundMessage; da instância da Karina
  // o handler importa apenas os avisos (notify*), nunca um sender de conversa.
  assert.match(handler, /sendInboundMessage/);
  assert.ok(!/\bsendMessage\b/.test(handler), 'handler do inbound importa o sender da Karina');
  const sender = ler('src/zapi/senderInbound.js');
  assert.match(sender, /ZAPI_INBOUND/);
  // Sem variável configurada, pula — não cai na outra instância.
  assert.match(sender, /if \(!configured\)[^]*skipped: true/);
});

test('o que não é conversa do inbound é repassado ao Hub, nunca engolido', () => {
  const wh = ler('src/webhook/zapiInboundHandler.js');
  // Os quatro caminhos de saída que não são o agente precisam repassar.
  const repasses = wh.match(/repassarParaOHub\(body\)/g) || [];
  assert.ok(repasses.length >= 4, `só ${repasses.length} repasse(s) — pesquisa ficaria em silêncio`);
  assert.match(wh, /webhook\/zapi\/ops/);
});

test('a fila das 8h respeita o modo da conversa', () => {
  const idx = ler('src/index.js');
  assert.match(idx, /modo === 'inbound'/);
  assert.match(idx, /processarFilaInbound/);
});

// ─── Prompt: as regras que o usuário pediu explicitamente ───────────────────

test('o prompt obriga avisar que a Karina chama de OUTRO número', () => {
  const p = ler('config/prompts/inbound.txt');
  assert.match(p, /de outro número/i);
  assert.match(p, /número diferente deste/i);
});

test('o agente não se apresenta como Karina', () => {
  // A Karina é pessoa real e entra depois, de OUTRO número. Se o agente usar o
  // nome dela, a lead recebe mensagem da "mesma pessoa" vinda de outro número
  // e a conversa inteira cheira a golpe no momento do handoff.
  const p = ler('config/prompts/inbound.txt');
  assert.match(p, /Você NÃO é a Karina/);
  assert.match(p, /Apresente-se SEM nome próprio/);
  assert.ok(!/Aqui é a Karina/.test(p), 'o modelo de abertura ainda usa o nome dela');
  // O handoff, ao contrário, PRECISA nomear a Karina: a lead tem de saber quem
  // vai chamar, senão ignora o número desconhecido.
  assert.match(p, /A Karina, que cuida da nossa agenda/);
});

test('o agente não afirma ser humano quando perguntado', () => {
  const p = ler('config/prompts/inbound.txt');
  assert.match(p, /NUNCA afirme ser uma pessoa/);
  assert.match(p, /Não invente um nome/);
});

test('o prompt pede turno E dias antes do handoff', () => {
  const p = ler('config/prompts/inbound.txt');
  assert.match(p, /turnos.*E.*dias|Precisa dos dois/s);
});

test('o vocabulário da qualificação é o mesmo do formulário /conversa', () => {
  // Os dois precisam ser comparáveis no relatório depois.
  const p = ler('config/prompts/inbound.txt');
  for (const v of ['escape', 'ciclo', 'culpa', 'autoestima', 'rotina',
                   'nutri_comp', 'cirurgia', 'hipo', 'sop', 'meno']) {
    assert.ok(p.includes(v), `vocabulário divergente do formulário: ${v}`);
  }
});

test('o agente não dá orientação de saúde nem agenda sozinho', () => {
  const p = ler('config/prompts/inbound.txt');
  assert.match(p, /NUNCA dá orientação nutricional/);
  assert.match(p, /Você NÃO agenda/);
});
