// Backfill do funil a partir do estado que já está no Redis.
//
// O funil só passou a ser reportado em 17/10/2026, mas as conversas anteriores
// não se perderam: `conv:{phone}` é gravado sem TTL, então o estado de ontem
// continua lá — origem, qualificação, turnos e handoff.
//
// Reconstruir a partir do ESTADO FINAL tem um limite honesto: dá para saber
// que a lead qualificou, não QUANDO. Os carimbos retroativos usam o início da
// conversa como referência, e é por isso que o relatório deve tratar números
// anteriores a 17/10 como aproximação de volume, não de ritmo.
//
// Rodar quantas vezes quiser é seguro: o event_id é determinístico e o Hub
// descarta repetição no ON CONFLICT.
//
// O que NÃO dá para recuperar: quem escreveu e caiu no repasse antes da
// correção de ontem. Essas conversas nunca existiram aqui. A diferença entre
// as conversas que a Meta conta e as que aparecerem aqui é justamente isso.

import { safeKeys, safeGet } from '../redis.js';
import { registrarEtapa } from './funil.js';

export async function backfillInbound({ dryRun = false } = {}) {
  const chaves = await safeKeys('conv:*');
  const resumo = { conversas: 0, etapas: 0, falhas: 0, porOrigem: {}, dryRun };

  for (const chave of chaves) {
    const raw = await safeGet(chave);
    if (!raw) continue;

    let conv;
    try { conv = JSON.parse(raw); } catch { continue; }
    if (conv.mode !== 'inbound' || !conv.inbound) continue;

    const phone = chave.slice('conv:'.length);
    const inb = conv.inbound;
    const origem = inb.origem || 'direto';
    const source = `inbound_${origem}`;
    const quando = inb.iniciadoEm || null;
    const nome = inb.nome || conv.leadData?.nome || null;

    resumo.conversas++;
    resumo.porOrigem[origem] = (resumo.porOrigem[origem] || 0) + 1;

    const etapas = [{ tipo: 'conversa_iniciada', occurredAt: quando }];

    // Ela respondeu se houve pelo menos um turno conduzido.
    if ((inb.turnos || 0) >= 1 || (inb.mensagensDoAgente || 0) > 1) {
      etapas.push({ tipo: 'primeira_resposta', occurredAt: quando });
    }
    if (inb.qualificacao?.completa) {
      etapas.push({ tipo: 'qualificada', occurredAt: quando, score: inb.score ?? null });
    }
    if (conv.handedOff) {
      etapas.push({ tipo: 'handoff', occurredAt: quando, motivo: 'backfill' });
    }
    if (inb.etapa === 'encerrada') {
      etapas.push({
        tipo: 'desqualificada', occurredAt: quando,
        motivo: inb.qualificacao?.completa ? 'encerrou_qualificada' : 'encerrou_sem_qualificar',
      });
    }

    for (const e of etapas) {
      if (dryRun) { resumo.etapas++; continue; }
      const ok = await registrarEtapa({ phone, source, nome, ...e });
      if (ok) resumo.etapas++; else resumo.falhas++;
    }
  }

  console.log(`[backfill-inbound] ${resumo.conversas} conversa(s), ${resumo.etapas} etapa(s)`
    + `${resumo.falhas ? `, ${resumo.falhas} falha(s)` : ''}${dryRun ? ' (simulação)' : ''}`);
  return resumo;
}

/** Endpoint manual. Protegido pelo mesmo segredo interno dos outros webhooks. */
export async function handleBackfill(req, res) {
  const esperado = process.env.HUB_WEBHOOK_SECRET || process.env.INTERNAL_WEBHOOK_SECRET;
  const recebido = req.headers['x-webhook-secret'] || req.body?.secret;
  if (!esperado || recebido !== esperado) {
    return res.status(401).json({ ok: false, error: 'Não autorizado' });
  }
  try {
    const resumo = await backfillInbound({ dryRun: req.body?.dry_run === true });
    res.json({ ok: true, ...resumo });
  } catch (err) {
    console.error('[backfill-inbound]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}
