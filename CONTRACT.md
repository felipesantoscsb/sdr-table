# Contrato de API — sdr-table ↔ aquisicao-table

## Endpoint: GET /api/lead-context

**Base URL:** `https://www.evelynliu.com.br`

**Produzido por:** repo `aquisicao-table` (Railway)  
**Consumido por:** templates do dossiê em `sdr-table` (bootstrap script no `<head>`)

### Request

```
GET /api/lead-context?lid={lead_event_id}
```

| Param | Tipo | Descrição |
|-------|------|-----------|
| `lid` | string | `lead_event_id` gerado no quiz — chave do registro Redis `lead:{lid}` |

### Response 200

```json
{
  "em_hash":     "sha256 do email normalizado (lowercase+trim)",
  "ph_hash":     "sha256 do phone E.164 (com DDI 55)",
  "fn_hash":     "sha256 do primeiro nome (lowercase+trim)",
  "external_id": "sha256 do email — identificador estável cross-evento",
  "first_name":  "Primeiro nome em texto puro (para interpolação visual)"
}
```

### Response 404

Corpo genérico `{}`. Ocorre quando `lid` inválido, expirado (TTL 90 dias) ou lead não completou o quiz.

### Comportamento esperado no template

1. `lid` presente → fetch `/api/lead-context?lid={lid}` com timeout 3s
2. Sucesso → `fbq('init', PIXEL, {em, ph, fn, external_id})` com dados recebidos
3. Falha / 404 / timeout → fallback silencioso: comportamento legado com `?ph=` ou cookie `tc_ph`
4. `lid` ausente → fallback imediato (retrocompatibilidade com links antigos)

---

## Campo: lead_event_id no webhook /webhook/quiz

**Produzido por:** `aquisicao-table/src/server.js` → `forwardToSDR()`  
**Consumido por:** `sdr-table/src/webhook/quizHandler.js` → `normalizeLead()`

O campo `lead_event_id` é enviado no payload do webhook POST `/webhook/quiz` e propagado por toda a cadeia de geração do dossiê até a URL final:

```
https://raiz.evelynliu.com.br/d/{slug}?lid={lead_event_id}
```

---

## Endpoint: POST /api/capi/dossie-view

Aceita campo adicional `lid` no body. Quando presente, o servidor faz lookup no Redis (`lead:{lid}`) e enriquece o `user_data` com `em`, `ph`, `fn`, `external_id`, `fbc`, `fbp` do lead original.

## Endpoint: POST /api/capi/initiate-checkout

Mesma lógica de enriquecimento via `lid`.

---

## Decisões registradas

- **DossieView server-side:** mantido em `/api/capi/dossie-view` para telemetria interna. Quando a Fase 2 (ViewContent nativo) for implementada, o servidor **não deve** repassar DossieView à Meta — apenas logar/registrar internamente.
- **PII no link:** o `lid` é um token opaco (UUID). Nenhum dado pessoal (email, telefone, nome) é exposto na URL do dossiê.
- **Retrocompatibilidade `?ph=`:** links antigos com `?ph={phone}` continuam funcionando indefinidamente até remoção explícita autorizada.
