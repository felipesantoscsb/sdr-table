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

export async function diagnosticoInbound({ amostras = 0, origem = null } = {}) {
  const chaves = await safeKeys('conv:*');

  const r = {
    chaves_conv: chaves.length,   // 0 aqui = Redis vazio ou inalcançável
    conversas: 0,
    outro_modo: 0,
    ilegiveis: 0,
    funil: { iniciou: 0, respondeu: 0, qualificou: 0, recebeu_oferta: 0, deu_disponibilidade: 0, handoff: 0 },
    por_origem: {},
    por_etapa_final: {},
    por_tier: {},
    turnos: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5+': 0 },
    handoff_motivo: {},
    sem_dor_texto: 0,
    amostras: [],
  };

  for (const chave of chaves) {
    const raw = await safeGet(chave);
    if (!raw) continue;

    let conv;
    try { conv = JSON.parse(raw); } catch { r.ilegiveis++; continue; }
    if (conv.mode !== 'inbound' || !conv.inbound) { r.outro_modo++; continue; }

    const inb = conv.inbound;
    const org = inb.origem || 'direto';
    if (origem && org !== origem) continue;

    r.conversas++;
    r.por_origem[org] = (r.por_origem[org] || 0) + 1;

    const etapa = inb.etapa || 'acolhimento';
    r.por_etapa_final[etapa] = (r.por_etapa_final[etapa] || 0) + 1;
    if (inb.tier) r.por_tier[inb.tier] = (r.por_tier[inb.tier] || 0) + 1;
    if (inb.handoffMotivo) r.handoff_motivo[inb.handoffMotivo] = (r.handoff_motivo[inb.handoffMotivo] || 0) + 1;

    const t = inb.turnos || 0;
    r.turnos[t >= 5 ? '5+' : String(t)]++;

    if (!(inb.qualificacao?.dor_texto || '').trim()) r.sem_dor_texto++;

    const d = degraus(inb);
    for (const [k, v] of Object.entries(d)) if (v) r.funil[k]++;

    if (r.amostras.length < amostras) {
      r.amostras.push({
        telefone: mascarar(chave.slice('conv:'.length)),
        origem: org,
        etapa,
        turnos: t,
        score: inb.score ?? null,
        dor_texto: inb.qualificacao?.dor_texto || '',
        // Só a conversa, sem leadData nem telefone no corpo.
        mensagens: (conv.messages || []).map(m => ({ de: m.role, texto: m.content })),
      });
    }
  }

  // Queda entre degraus: é ela que aponta onde investir, não o total.
  const ordem = ['iniciou', 'respondeu', 'qualificou', 'recebeu_oferta', 'deu_disponibilidade', 'handoff'];
  r.queda = {};
  for (let i = 1; i < ordem.length; i++) {
    const de = r.funil[ordem[i - 1]];
    const para = r.funil[ordem[i]];
    r.queda[`${ordem[i - 1]}_para_${ordem[i]}`] = de ? `${((para / de) * 100).toFixed(1)}%` : 'n/d';
  }

  return r;
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
    const resumo = await diagnosticoInbound({ amostras, origem: req.body?.origem || null });
    res.json({ ok: true, ...resumo });
  } catch (err) {
    console.error('[diagnostico-inbound]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}
