// src/webhook/tictoHandler.js

import { safeGet, safeSet, safeDel } from '../redis.js';
import { normalizePhone } from '../conversation/store.js';

const COMPRA_TTL_SEC = 30 * 24 * 60 * 60; // 30 dias

export async function handleTicto(req, res) {
  const body = req.body || {};

  const token = req.headers['x-ticto-token'] || body.token;
  if (token !== process.env.TICTO_POSTBACK_TOKEN) {
    console.warn('⚠️ Ticto webhook com token inválido');
    return res.status(200).json({ ok: true });
  }

  const status = body.status;

  if (status !== 'approved' && status !== 'paid') {
    return res.status(200).json({ ok: true, ignored: true });
  }

  try {
    const customer = body.customer || {};
    const item     = body.item     || {};

    const ddi    = String(customer.phone?.ddi || '').replace(/\D/g, '');
    const ddd    = String(customer.phone?.ddd || '').replace(/\D/g, '');
    const number = String(customer.phone?.number || '').replace(/\D/g, '');
    const rawPhone = ddi + ddd + number;
    const phone = normalizePhone(rawPhone);

    const nome    = customer.name || 'Lead';
    const produto = [item.product_name, item.offer_name].filter(Boolean).join(' — ');

    await safeSet(
      `compra:${phone}`,
      JSON.stringify({ nome, phone, produto, timestamp: Date.now() }),
      'EX', COMPRA_TTL_SEC
    );

    // Cancela TODO o fluxo de recuperação do quiz (NÃO toca no agente/conv:)
    await safeDel(`quiz:${phone}`);
    await safeDel(`pending_dossie:${phone}`);
    await safeDel(`pending_followup:${phone}`);
    await safeDel(`followup:${phone}`);

    // Track é keyed por uuid — resolve via índice phone→uuid e limpa
    const trackUuid = await safeGet(`followup_uuid:${phone}`);
    if (trackUuid) {
      await safeDel(`track:${trackUuid}`);
      await safeDel(`followup_uuid:${phone}`);
    }

    console.log(`✅ Compra Ticto: ${nome} (${phone}) — ${produto}`);
  } catch (err) {
    console.error('❌ Erro ao processar Ticto:', err.message);
  }

  return res.status(200).json({ ok: true });
}
