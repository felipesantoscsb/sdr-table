// src/index.js
// Ponto de entrada da aplicação.
// Monta o servidor Express e registra as rotas.

import express from 'express';
import { config } from '../config/index.js';
import { handleMakeLead } from './webhook/makeHandler.js';
import { handleZapiMessage } from './webhook/zapiHandler.js';

const app = express();

// Parse de JSON — necessário para ler req.body
app.use(express.json());

// ─── Rotas ───────────────────────────────────────────────────────────────────

// Webhook do Make: recebe novos leads
// Configure esta URL no Make como "HTTP > Make a Request"
app.post('/webhook/lead', handleMakeLead);

// Webhook da Zapi: recebe mensagens do WhatsApp
// Configure esta URL no painel da Zapi em "Webhooks > On Message Received"
app.post('/webhook/zapi', handleZapiMessage);

// Health check — útil para monitoramento e verificar se o servidor está no ar
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()) + 's',
    timestamp: new Date().toISOString(),
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`
🚀 SDR WhatsApp rodando na porta ${config.port}

Endpoints disponíveis:
  POST /webhook/lead  → Recebe leads do Make
  POST /webhook/zapi  → Recebe mensagens da Zapi
  GET  /health        → Status do servidor

Para expor localmente: npx ngrok http ${config.port}
  `);
});
