// Onde as conversas de inbound morrem.
//
// Nasceu de uma pergunta de conversão: a taxa de conversa iniciada para
// pré-consulta está fraca e não dava para saber em que ponto. A alternativa
// era abrir o Redis de produção, que além de expor credencial traria
// transcrição de mulher descrevendo dor alimentar, ansiedade e diagnóstico.
// Dado de saúde de terceiro não precisa sair daqui para responder isso.
//
// Por padrão devolve só contagem. Amostra de texto é opt-in explícito, com o
// telefone sempre mascarado.

import { safeKeys, safeGet } from '../redis.js';

/**
 * Deploy do prompt enxuto, da abertura direta e da limpeza de travessão.
 * É o divisor natural entre o comportamento velho e o novo, e vira o corte
 * padrão para não comparar épocas diferentes sem perceber.
 */
export const CORTE_PADRAO = '2026-10-19T16:14:00-03:00';

/** Últimos 4 dígitos. O suficiente para a equipe achar a conversa no aparelho. */
function mascarar(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length <= 4 ? '****' : `****${d.slice(-4)}`;
}

/**
 * A conversa avança por degraus, e cada um só conta se o anterior aconteceu.
 * Medir assim mostra o degrau que derruba, que é a pergunta real.
 */
function degraus(inb) {
  const turnos = inb.turnos || 0;
  const etapa = inb.etapa || 'acolhimento';
  const disp = inb.disponibilidade || {};
  return {
    iniciou: true,
    respondeu: turnos >= 1 || (inb.mensagensDoAgente || 0) > 1,
    qualificou: inb.qualificacao?.completa === true,
    // A oferta sai quando o agente passa de "qualificando". Aqui é leitura de
    // estado, não opinião do modelo.
    recebeu_oferta: ['disponibilidade', 'pronta', 'protocolo_raiz'].includes(etapa),
    deu_disponibilidade: (disp.turnos || []).length > 0 && (disp.dias || []).length > 0,
    handoff: inb.handoff === true || etapa === 'pronta',
  };
}

/** Balde vazio. Um por lado do corte, com a mesma forma. */
function balde() {
  return {
    conversas: 0,
    funil: { iniciou: 0, respondeu: 0, qualificou: 0, recebeu_oferta: 0, deu_disponibilidade: 0, handoff: 0 },
    por_origem: {},
    por_etapa_final: {},
    por_tier: {},
    turnos: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5+': 0 },
    handoff_motivo: {},
    sem_dor_texto: 0,
    amostras: [],
  };
}

/**
 * Queda entre degraus: é ela que aponta onde investir, não o total.
 */
function calcularQueda(b) {
  const ordem = ['iniciou', 'respondeu', 'qualificou', 'recebeu_oferta', 'deu_disponibilidade', 'handoff'];
  b.queda = {};
  for (let i = 1; i < ordem.length; i++) {
    const de = b.funil[ordem[i - 1]];
    const para = b.funil[ordem[i]];
    b.queda[`${ordem[i - 1]}_para_${ordem[i]}`] = de ? `${((para / de) * 100).toFixed(1)}%` : 'n/d';
  }
  return b;
}

function acumular(b, inb, conv, chave, amostras) {
  const org = inb.origem || 'direto';
  b.conversas++;
  b.por_origem[org] = (b.por_origem[org] || 0) + 1;

  const etapa = inb.etapa || 'acolhimento';
  b.por_etapa_final[etapa] = (b.por_etapa_final[etapa] || 0) + 1;
  if (inb.tier) b.por_tier[inb.tier] = (b.por_tier[inb.tier] || 0) + 1;
  if (inb.handoffMotivo) b.handoff_motivo[inb.handoffMotivo] = (b.handoff_motivo[inb.handoffMotivo] || 0) + 1;

  const t = inb.turnos || 0;
  b.turnos[t >= 5 ? '5+' : String(t)]++;
  if (!(inb.qualificacao?.dor_texto || '').trim()) b.sem_dor_texto++;

  const d = degraus(inb);
  for (const [k, v] of Object.entries(d)) if (v) b.funil[k]++;

  if (b.amostras.length < amostras) {
    b.amostras.push({
      telefone: mascarar(chave.slice('conv:'.length)),
      origem: org,
      etapa,
      turnos: t,
      score: inb.score ?? null,
      dor_texto: inb.qualificacao?.dor_texto || '',
      iniciadoEm: inb.iniciadoEm || null,
      mensagens: (conv.messages || []).map(m => ({ de: m.role, texto: m.content })),
    });
  }
}

/**
 * `corte` (ISO) divide o resultado em antes e depois, para medir o efeito de
 * uma mudanca sem comparar epocas diferentes de olho.
 *
 * O corte e pela DATA DE INICIO da conversa, que e a regra sob a qual ela
 * viveu. Conversa sem `iniciadoEm` (anterior a 16/10/2026) vai para
 * `sem_data`, nunca para um dos lados: somar a um deles inventaria resultado.
 */
export async function diagnosticoInbound({ amostras = 0, origem = null, corte = null } = {}) {
  const chaves = await safeKeys('conv:*');
  const limite = corte ? new Date(corte).getTime() : null;
  if (corte && Number.isNaN(limite)) throw new Error('corte inválido, use ISO 8601');

  const r = {
    chaves_conv: chaves.length,   // 0 aqui = Redis vazio ou inalcançável
    outro_modo: 0,
    ilegiveis: 0,
    corte: corte || null,
    sem_data: 0,
  };
  const antes = balde();
  const depois = balde();
  const unico = balde();

  for (const chave of chaves) {
    const raw = await safeGet(chave);
    if (!raw) continue;

    let conv;
    try { conv = JSON.parse(raw); } catch { r.ilegiveis++; continue; }
    if (conv.mode !== 'inbound' || !conv.inbound) { r.outro_modo++; continue; }

    const inb = conv.inbound;
    if (origem && (inb.origem || 'direto') !== origem) continue;

    if (!limite) { acumular(unico, inb, conv, chave, amostras); continue; }

    const nasceu = inb.iniciadoEm ? new Date(inb.iniciadoEm).getTime() : NaN;
    if (Number.isNaN(nasceu)) { r.sem_data++; continue; }
    acumular(nasceu < limite ? antes : depois, inb, conv, chave, amostras);
  }

  if (!limite) return { ...r, ...calcularQueda(unico) };
  return { ...r, antes: calcularQueda(antes), depois: calcularQueda(depois) };
}

export async function handleDiagnostico(req, res) {
  const esperado = process.env.HUB_WEBHOOK_SECRET || process.env.INTERNAL_WEBHOOK_SECRET;
  const recebido = req.headers['x-webhook-secret'] || req.body?.secret;
  if (!esperado || recebido !== esperado) {
    return res.status(401).json({ ok: false, error: 'Não autorizado' });
  }
  try {
    // Amostra é opt-in e limitada: o padrão nunca devolve texto de conversa.
    const amostras = Math.min(Number(req.body?.amostras) || 0, 20);
    const resumo = await diagnosticoInbound({
      amostras,
      origem: req.body?.origem || null,
      // Corte padrão: o deploy do prompt novo, em 19/10/2026 16:14 (BRT).
      corte: req.body?.corte === false ? null : (req.body?.corte || CORTE_PADRAO),
    });
    res.json({ ok: true, ...resumo });
  } catch (err) {
    console.error('[diagnostico-inbound]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}
