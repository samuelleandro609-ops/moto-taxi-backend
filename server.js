"use strict";

/**
 * moto-taxi-backend
 *
 * Backend do Moto Taxi Timbauba. Cria cobrancas Pix via Mercado Pago.
 * Uso unico: a DIARIA (R$ 5) que o mototaxi paga para rodar no app.
 * O comercio NAO paga nada a dona e nao usa este backend: o comercio paga
 * a entrega direto ao entregador, e o passageiro paga a corrida direto ao
 * mototaxi (Pix dele ou dinheiro), sem passar pelo app.
 *
 * O token de acesso do Mercado Pago vem SOMENTE da variavel de ambiente
 * MP_ACCESS_TOKEN. Nunca coloque o token no codigo, em arquivo ou em log.
 * Sem MP_ACCESS_TOKEN, /create-pix responde 503 e nunca gera QR falso.
 *
 * Presenca e chamados (/presence, /calls): o site e estatico e cada
 * aparelho so ve o proprio localStorage. Estes endpoints guardam em
 * MEMORIA quem esta online e quais chamados estao pendentes, para que um
 * celular e um PC vejam a mesma coisa. Nao ha banco de dados: se o
 * servico reiniciar (Render Free dorme), presenca e chamados somem e os
 * aparelhos reenviam o heartbeat / recriam o chamado. Nada aqui usa
 * chave ou token.
 *
 * Valores (/settings): a Administracao edita corrida, entrega e diaria;
 * o servidor guarda em MEMORIA e todos os aparelhos leem daqui, para o
 * valor valer em todos os aparelhos e nao so onde foi editado.
 *
 * Contas (/auth): registro e login no SERVIDOR (telefone + senha), para
 * a mesma conta funcionar em qualquer aparelho — antes a conta so
 * existia no localStorage de cada aparelho e a conta criada no celular
 * nao existia no PC (o login no PC dizia "incorreto" mesmo com a senha
 * certa). Senhas nunca ficam em texto claro: scrypt com salt (crypto
 * nativo, sem dependencia nova). Contas e sessoes ficam em accounts.json
 * (escrita atomica: grava temporario e renomeia), lido na inicializacao.
 * A primeira conta registrada vira admin (como era no aparelho: a
 * primeira conta criada). No Render Free o disco e efemero: se o
 * servico reiniciar, o arquivo some e as contas voltam pela migracao
 * automatica do app (ele reenvia a conta local uma vez); no VPS o disco
 * persiste e nada se perde. O Postgres gratuito do Render NAO serve
 * aqui: ele expira e e apagado depois de ~30 dias, entao as contas
 * sumiriam sozinhas.
 *
 * Comunicacao na corrida: SO o chat de texto "Converse com o
 * mototaxi" (/calls/:id/messages). O app le em voz alta (voz do
 * Google) o que o OUTRO digitou — nunca a propria mensagem. O VoIP
 * ao vivo (walkie-talkie, WebRTC) foi REMOVIDO (nao funcionou):
 * sem botao de falar, sem codigo WebRTC e sem os endpoints de
 * sinalizacao /calls/:id/signal.
 *
 * v1.5.0: chamado/rota PERSISTE (GET /calls?callerPhone busca o
 * chamado ativo de quem chamou; POST /calls/:id/touch mantem o
 * chamado vivo enquanto o app esta aberto; POST /calls/:id/cancel
 * cancela — cliente ou moto; TTLs maiores); modo gratuito da diaria
 * (freeFee em /settings — com ele ligado o moto trabalha sem pagar,
 * sem Pix; com ele desligado o Pix vale como antes); chat da corrida
 * (/calls/:id/messages — texto entre cliente e moto, para o app ler
 * em voz alta no outro aparelho). GET /calls?excludeCaller tira o
 * chamado da lista de quem chamou (o chamado so vai para os motos).
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const MP_API = "https://api.mercadopago.com/v1/payments";
const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || "https://moto-taxi-timbauba.onrender.com";

// CORS manual e estrito: so o site do Moto Taxi Timbauba recebe
// Access-Control-Allow-Origin. Outra origem nao recebe o cabecalho,
// entao o navegador dela bloqueia a resposta. Requisicoes sem Origin
// (curl, servidor-para-servidor) passam sem cabecalho CORS.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Max-Age", "86400");
      return res.sendStatus(204);
    }
  }
  return next();
});
app.use(express.json({ limit: "256kb" }));

// Corpo JSON invalido -> 400 em JSON (em vez do HTML padrao do Express).
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res
      .status(400)
      .json({ error: "invalid_json", message: "Corpo JSON invalido." });
  }
  return next(err);
});

function mpToken() {
  const t = (process.env.MP_ACCESS_TOKEN || "").trim();
  return t || null;
}

function tokenNotConfigured(res) {
  return res.status(503).json({
    error: "token_not_configured",
    message:
      "MP_ACCESS_TOKEN is not configured on this server. Set it in the Render dashboard Environment settings."
  });
}

async function mpRequest(path, options) {
  const token = mpToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    };
    // O Mercado Pago exige X-Idempotency-Key em POST /v1/payments: sem
    // ele a API recusa com 502 "Header X-Idempotency-Key can't be null".
    // Quem chama passa a chave (no /create-pix e o external_ref, unico
    // por cobranca, entao uma repeticao nao cria outra cobranca).
    if (options && options.idempotencyKey) {
      headers["X-Idempotency-Key"] = String(options.idempotencyKey);
    }
    const resp = await fetch(MP_API + path, {
      method: (options && options.method) || "GET",
      body: options && options.body ? options.body : undefined,
      signal: controller.signal,
      headers
    });
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }
    return { status: resp.status, ok: resp.ok, data, raw: text };
  } finally {
    clearTimeout(timer);
  }
}

function mpErrorDetail(result) {
  if (result.data && (result.data.message || result.data.error)) {
    return String(result.data.message || result.data.error);
  }
  return result.raw ? String(result.raw) : "Mercado Pago error";
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "moto-taxi-backend", version: "1.5.0" });
});

app.post("/create-pix", async (req, res) => {
  if (!mpToken()) return tokenNotConfigured(res);

  const body = req.body || {};
  const amount = body.amount;
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const external_ref =
    typeof body.external_ref === "string" ? body.external_ref.trim() : "";
  const payer_email =
    typeof body.payer_email === "string" ? body.payer_email.trim() : "";

  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      error: "invalid_amount",
      message: "amount must be a positive number."
    });
  }
  if (!description) {
    return res
      .status(400)
      .json({ error: "missing_description", message: "description is required." });
  }
  if (!external_ref) {
    return res.status(400).json({
      error: "missing_external_ref",
      message: "external_ref is required."
    });
  }
  if (!payer_email || payer_email.indexOf("@") === -1) {
    return res.status(400).json({
      error: "invalid_payer_email",
      message: "payer_email must be a valid email address."
    });
  }

  try {
    const result = await mpRequest("", {
      method: "POST",
      idempotencyKey: external_ref,
      body: JSON.stringify({
        transaction_amount: amount,
        description,
        payment_method_id: "pix",
        payer: { email: payer_email },
        external_reference: external_ref
      })
    });

    if (!result.ok) {
      return res.status(502).json({
        error: "mercadopago_error",
        status: result.status,
        detail: mpErrorDetail(result).slice(0, 500)
      });
    }

    const d = result.data || {};
    const tx =
      (d.point_of_interaction && d.point_of_interaction.transaction_data) || {};
    return res.status(201).json({
      id: d.id,
      status: d.status,
      qr_code: tx.qr_code || d.qr_code || null,
      qr_code_base64: tx.qr_code_base64 || d.qr_code_base64 || null,
      ticket_url: tx.ticket_url || d.ticket_url || null
    });
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "Mercado Pago request timed out."
        : "Could not reach Mercado Pago.";
    return res.status(502).json({ error: "mercadopago_unreachable", message: msg });
  }
});

app.get("/payment/:id", async (req, res) => {
  if (!mpToken()) return tokenNotConfigured(res);

  const id = String(req.params.id || "").trim();
  if (!id) {
    return res
      .status(400)
      .json({ error: "missing_id", message: "payment id is required." });
  }

  try {
    const result = await mpRequest("/" + encodeURIComponent(id), {
      method: "GET"
    });

    if (!result.ok) {
      return res.status(502).json({
        error: "mercadopago_error",
        status: result.status,
        detail: mpErrorDetail(result).slice(0, 500)
      });
    }

    const d = result.data || {};
    return res.json({
      id: d.id,
      status: d.status,
      status_detail: d.status_detail || null,
      transaction_amount: d.transaction_amount,
      external_reference: d.external_reference || null
    });
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "Mercado Pago request timed out."
        : "Could not reach Mercado Pago.";
    return res.status(502).json({ error: "mercadopago_unreachable", message: msg });
  }
});

// ---------------------------------------------------------------------------
// Valores (corrida, entrega, diaria) — sincronizacao entre aparelhos
//
// A Administracao do site edita os valores; o site grava aqui (POST
// /settings) e todos os aparelhos leem daqui (GET /settings, a cada
// ~25 s). Antes nao havia rota no servidor e o valor so mudava no
// aparelho onde foi editado (o mototaxi continuava vendo R$ 8).
// Em MEMORIA, como presenca e chamados: se o servico reiniciar, volta
// aos padroes (corrida 8, entrega 7, diaria 5) e a Administracao grava
// de novo. settingsAt e o carimbo da alteracao: so vale o mais recente,
// para um aparelho atrasado nao ressuscitar um valor antigo.
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = { ride: 8, delivery: 7, fee: 5, freeFee: false };
let appSettings = { ...DEFAULT_SETTINGS, settingsAt: 0 };

// Modo gratuito da diaria: quando freeFee e true, o mototaxi trabalha
// sem pagar a diaria (sem Pix, sem trava). Com freeFee false, o Pix
// vale como antes (pagamento obrigatorio, paidUntil 24h). Zerar o valor
// da diaria SOZINHO nao deixa gratis — sem a flag, a trava continua
// exigindo paidUntil e ninguem consegue ficar online.
function pickBoolean(body, keys) {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "sim") return true;
      if (s === "false" || s === "0" || s === "nao" || s === "não") return false;
    }
  }
  return undefined;
}

function pickNumber(body, keys) {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return undefined;
}

function settingsPublic() {
  const s = appSettings;
  // Devolve todas as variacoes de nome que o site pode usar, no topo e
  // aninhadas em "settings", para o aparelho achar os valores do jeito
  // que ele espera.
  return {
    ok: true,
    ride: s.ride,
    delivery: s.delivery,
    fee: s.fee,
    freeFee: !!s.freeFee,
    free_fee: !!s.freeFee,
    diariaGratis: !!s.freeFee,
    ridePrice: s.ride,
    deliveryPrice: s.delivery,
    dailyFee: s.fee,
    corrida: s.ride,
    entrega: s.delivery,
    diaria: s.fee,
    settingsAt: s.settingsAt,
    settings: {
      ride: s.ride,
      delivery: s.delivery,
      fee: s.fee,
      freeFee: !!s.freeFee,
      free_fee: !!s.freeFee,
      diariaGratis: !!s.freeFee,
      ridePrice: s.ride,
      deliveryPrice: s.delivery,
      dailyFee: s.fee,
      corrida: s.ride,
      entrega: s.delivery,
      diaria: s.fee,
      settingsAt: s.settingsAt
    }
  };
}

// GET /settings — valores atuais para todos os aparelhos.
app.get("/settings", (req, res) => {
  return res.json(settingsPublic());
});

// POST /settings — a Administracao grava os valores novos. Corpo com os
// valores e settingsAt (carimbo). So vale se o carimbo for mais recente
// que o guardado; um POST mais antigo nao sobrescreve o mais novo.
app.post("/settings", (req, res) => {
  const body = req.body || {};
  const ride = pickNumber(body, ["ride", "ridePrice", "priceRide", "corrida", "ride_value"]);
  const delivery = pickNumber(body, ["delivery", "deliveryPrice", "priceDelivery", "entrega", "delivery_value"]);
  const fee = pickNumber(body, ["fee", "dailyFee", "diaria", "daily_fee", "daily", "fee_value"]);
  const freeFee = pickBoolean(body, ["freeFee", "free_fee", "free", "diariaGratis", "gratis"]);
  const at = pickNumber(body, ["settingsAt", "updatedAt", "timestamp", "version"]);

  if (ride === undefined && delivery === undefined && fee === undefined && freeFee === undefined) {
    return res.status(400).json({
      error: "invalid_settings",
      message: "at least one of ride, delivery, fee or freeFee must be provided."
    });
  }
  const incomingAt = typeof at === "number" ? at : Date.now();
  if (incomingAt < appSettings.settingsAt) {
    // Carimbo mais antigo que o guardado: nao sobrescreve.
    return res.json({ ok: true, stale: true, ...settingsPublic() });
  }
  if (ride !== undefined) appSettings.ride = ride;
  if (delivery !== undefined) appSettings.delivery = delivery;
  if (fee !== undefined) appSettings.fee = fee;
  if (freeFee !== undefined) appSettings.freeFee = freeFee;
  appSettings.settingsAt = incomingAt;
  return res.json({ ok: true, ...settingsPublic() });
});

// ---------------------------------------------------------------------------
// Presenca e chamados (sincronizacao entre aparelhos, nos DOIS sentidos)
//
// O site e estatico: cada aparelho so ve o proprio localStorage. Estes
// endpoints guardam em MEMORIA quem esta online e quais chamados estao
// pendentes, para que qualquer aparelho veja o mesmo estado — um celular
// online aparece no PC e um PC online aparece no celular; um chamado
// feito em qualquer aparelho chega ao mototaxi em qualquer aparelho.
// Nao ha banco de dados: se o servico reiniciar (Render Free dorme),
// presenca e chamados somem e os aparelhos reenviam o heartbeat /
// recriam o chamado. Nada aqui usa chave ou token.
// ---------------------------------------------------------------------------

const PRESENCE_TTL_MS = 15000; // heartbeat recente: ultimos 15 s
// O chamado/rota PERSISTE: so termina quando alguem cancela ou conclui
// (ou conclui a entrega/corrida). Por isso os prazos sao longos —
// fechar a janela ou o app nao pode apagar o chamado. O app mantem o
// chamado vivo com POST /calls/:id/touch enquanto esta aberto, e ao
// reabrir busca o chamado ativo (GET /calls?callerPhone / ?mine).
const CALL_PENDING_TTL_MS = 60 * 60 * 1000; // chamado pendente expira em 60 min
const CALL_ACTIVE_TTL_MS = 180 * 60 * 1000; // aceito expira em 180 min (3 h)
const CALL_DONE_TTL_MS = 10 * 60 * 1000; // concluido/cancelado fica visivel por 10 min

// key (chave da conta) -> { key, name, photo, bike, plate, lat, lng, online, updatedAt }
const presence = new Map();
// id -> { id, callerName, callerPhone, targetKey, targetName, type, pickup,
//         destination, amount, status, phase, acceptedBy, acceptedName,
//         createdAt, updatedAt, completedAt }
const calls = new Map();
let callSeq = 0;

function cleanStr(v, max) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function freshPresence(p) {
  return Date.now() - p.updatedAt <= PRESENCE_TTL_MS;
}

function callPublic(c) {
  return {
    id: c.id,
    callerName: c.callerName,
    callerPhone: c.callerPhone,
    targetKey: c.targetKey,
    targetName: c.targetName,
    type: c.type,
    pickup: c.pickup,
    destination: c.destination,
    amount: c.amount,
    status: c.status,
    phase: c.phase,
    acceptedBy: c.acceptedBy,
    acceptedName: c.acceptedName,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    completedAt: c.completedAt
  };
}

function pruneStores() {
  const now = Date.now();
  for (const [key, p] of presence) {
    if (now - p.updatedAt > PRESENCE_TTL_MS) presence.delete(key);
  }
  for (const [id, c] of calls) {
    const ttl =
      c.status === "pending"
        ? CALL_PENDING_TTL_MS
        : c.status === "accepted"
          ? CALL_ACTIVE_TTL_MS
          : CALL_DONE_TTL_MS;
    if (now - c.updatedAt > ttl) {
      calls.delete(id);
      chatMessages.delete(id);
    }
  }
}
setInterval(pruneStores, 10000).unref();

// POST /presence — heartbeat do mototaxi (chamado a cada poucos segundos
// enquanto ele esta online). Corpo: { key, name, photo, bike, plate, lat,
// lng, online }. online=false tira o moto da lista na hora. Se photo
// vier vazia, mantem a foto do heartbeat anterior.
app.post("/presence", (req, res) => {
  const body = req.body || {};
  const key = cleanStr(body.key, 128);
  if (!key) {
    return res
      .status(400)
      .json({ error: "missing_key", message: "key is required." });
  }
  if (body.online !== true) {
    presence.delete(key);
    return res.json({ ok: true, online: false, key });
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return res
      .status(400)
      .json({ error: "invalid_location", message: "lat/lng are required." });
  }
  const prev = presence.get(key);
  const photo = cleanStr(body.photo, 200000);
  presence.set(key, {
    key,
    name: cleanStr(body.name, 80),
    photo: photo || (prev ? prev.photo : ""),
    bike: cleanStr(body.bike, 80),
    plate: cleanStr(body.plate, 16),
    lat,
    lng,
    online: true,
    updatedAt: Date.now()
  });
  return res.json({ ok: true, online: true, key });
});

// GET /presence — motos online agora (so as com heartbeat nos ultimos 15 s).
app.get("/presence", (req, res) => {
  pruneStores();
  const drivers = [];
  for (const p of presence.values()) {
    if (!freshPresence(p)) continue;
    drivers.push({
      key: p.key,
      name: p.name,
      photo: p.photo,
      bike: p.bike,
      plate: p.plate,
      lat: p.lat,
      lng: p.lng,
      updatedAt: p.updatedAt
    });
  }
  return res.json({ ok: true, drivers, count: drivers.length });
});

// POST /calls — cria um chamado. Corpo: { callerName, callerPhone,
// targetKey (null = para qualquer moto), targetName, type
// ("corrida"|"entrega"), pickup, destination, amount }.
app.post("/calls", (req, res) => {
  const body = req.body || {};
  const type = cleanStr(body.type, 20);
  if (type !== "corrida" && type !== "entrega") {
    return res.status(400).json({
      error: "invalid_type",
      message: 'type must be "corrida" or "entrega".'
    });
  }
  const pickup = cleanStr(body.pickup, 300);
  const destination = cleanStr(body.destination, 300);
  if (!pickup || !destination) {
    return res.status(400).json({
      error: "missing_address",
      message: "pickup and destination are required."
    });
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({
      error: "invalid_amount",
      message: "amount must be a number >= 0."
    });
  }
  const id =
    "call_" +
    Date.now().toString(36) +
    "_" +
    (callSeq++).toString(36) +
    Math.floor(Math.random() * 1296).toString(36);
  const now = Date.now();
  const call = {
    id,
    callerName: cleanStr(body.callerName, 80),
    callerPhone: cleanStr(body.callerPhone, 32),
    targetKey: cleanStr(body.targetKey, 128) || null,
    targetName: cleanStr(body.targetName, 80) || null,
    type,
    pickup,
    destination,
    amount,
    status: "pending",
    phase: "aguardando",
    acceptedBy: null,
    acceptedName: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  };
  calls.set(id, call);
  return res.status(201).json({ ok: true, call: callPublic(call) });
});

// GET /calls — chamados pendentes (padrao). ?status=all lista todos;
// ?mine=<key> lista os aceitos por aquele mototaxi (para ele acompanhar
// o chamado ativo dele em qualquer aparelho); ?callerPhone=<telefone>
// lista os chamados ATIVOS (pendente ou aceito) de quem chamou — e o
// que o app usa ao reabrir para RESTAURAR o chamado/rota que estava
// em andamento; ?excludeCaller=<telefone> tira da lista os chamados
// feitos por aquele telefone — e o que os motos usam para o chamado
// NAO aparecer para quem chamou (só vai para quem esta trabalhando).
app.get("/calls", (req, res) => {
  pruneStores();
  const status = cleanStr(req.query.status, 20) || "pending";
  const mine = cleanStr(req.query.mine, 128);
  const callerPhone = normalizePhone(req.query.callerPhone || "");
  const excludeCaller = normalizePhone(req.query.excludeCaller || "");
  const list = [];
  for (const c of calls.values()) {
    if (callerPhone) {
      // Chamado ativo de quem chamou: so pendente ou aceito.
      if (normalizePhone(c.callerPhone) !== callerPhone) continue;
      if (c.status !== "pending" && c.status !== "accepted") continue;
    } else if (mine) {
      if (c.acceptedBy !== mine) continue;
    } else if (status !== "all" && c.status !== status) {
      continue;
    }
    // O chamado nunca aparece para quem chamou.
    if (excludeCaller && normalizePhone(c.callerPhone) === excludeCaller) continue;
    list.push(callPublic(c));
  }
  list.sort((a, b) => a.createdAt - b.createdAt);
  return res.json({ ok: true, calls: list, count: list.length });
});

// GET /calls/:id — detalhe de um chamado.
app.get("/calls/:id", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  return res.json({ ok: true, call: callPublic(c) });
});

// POST /calls/:id/accept — um mototaxi aceita o chamado. Corpo:
// { key, name }. So o primeiro aceita (os outros recebem 409 e o
// chamado some da lista de pendentes deles). Se o chamado foi dirigido
// a um moto (targetKey), so ele pode aceitar (403 para os demais).
app.post("/calls/:id/accept", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  if (c.status !== "pending") {
    return res.status(409).json({
      error: "call_not_pending",
      message: "call is already " + c.status + ".",
      call: callPublic(c)
    });
  }
  const body = req.body || {};
  const key = cleanStr(body.key, 128);
  if (!key) {
    return res
      .status(400)
      .json({ error: "missing_key", message: "key is required." });
  }
  if (c.targetKey && c.targetKey !== key) {
    return res.status(403).json({
      error: "not_targeted_driver",
      message: "this call is directed to another driver."
    });
  }
  c.status = "accepted";
  c.phase = "a_caminho_coleta";
  c.acceptedBy = key;
  c.acceptedName = cleanStr(body.name, 80);
  c.updatedAt = Date.now();
  return res.json({ ok: true, call: callPublic(c) });
});

// POST /calls/:id/phase — atualiza a fase do chamado. Corpo:
// { phase } — ex.: "coleta_confirmada", "a_caminho_entrega".
// Nao aceita fase em chamado ja concluido (409).
app.post("/calls/:id/phase", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  if (c.status === "completed") {
    return res.status(409).json({
      error: "call_completed",
      message: "call is already completed.",
      call: callPublic(c)
    });
  }
  const body = req.body || {};
  const phase = cleanStr(body.phase, 40);
  if (!phase) {
    return res
      .status(400)
      .json({ error: "missing_phase", message: "phase is required." });
  }
  c.phase = phase;
  c.updatedAt = Date.now();
  return res.json({ ok: true, call: callPublic(c) });
});

// POST /calls/:id/complete — conclui o chamado. Corpo: { key }.
// So o mototaxi que aceitou pode concluir (403 para outro).
app.post("/calls/:id/complete", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  if (c.status === "completed") {
    return res.json({ ok: true, call: callPublic(c) });
  }
  const body = req.body || {};
  const key = cleanStr(body.key, 128);
  if (c.acceptedBy && key && c.acceptedBy !== key) {
    return res.status(403).json({
      error: "not_accepted_driver",
      message: "only the driver who accepted can complete this call."
    });
  }
  c.status = "completed";
  c.phase = "concluido";
  c.completedAt = Date.now();
  c.updatedAt = Date.now();
  return res.json({ ok: true, call: callPublic(c) });
});

// POST /calls/:id/cancel — cancela o chamado. Corpo: { key } (id da
// conta). Pode cancelar: o CLIENTE que chamou (o telefone da conta
// bate com callerPhone) ou o MOTOTAXI que aceitou (key == acceptedBy).
// Vale em chamado pendente ou aceito — o cliente cancela desde
// "procurando mototaxi" e durante toda a espera e a rota. Cancelado
// fica visivel por 10 min (como concluido) e depois some. Cancelar
// de novo um chamado ja cancelado/concluido devolve o estado atual
// (sem erro), para um toque duplo nao quebrar nada.
app.post("/calls/:id/cancel", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  if (c.status === "completed" || c.status === "cancelled") {
    return res.json({ ok: true, already: true, call: callPublic(c) });
  }
  const body = req.body || {};
  const key = cleanStr(body.key, 128);
  const isDriver = !!c.acceptedBy && key === c.acceptedBy;
  const isCaller = callParty(c, "caller", key);
  if (!isDriver && !isCaller) {
    return res.status(403).json({
      error: "not_call_party",
      message: "only the caller or the driver who accepted can cancel this call."
    });
  }
  c.status = "cancelled";
  c.phase = "cancelado";
  c.completedAt = Date.now();
  c.updatedAt = Date.now();
  return res.json({ ok: true, call: callPublic(c) });
});

// POST /calls/:id/touch — uma ponta avisa que ainda esta com o app
// aberto no chamado (o app chama a cada poll do chamado ativo, dos
// dois lados). Atualiza o updatedAt para o chamado nao expirar
// enquanto alguem esta olhando — fechar a janela e reabrir nao apaga
// o chamado. So as duas pontas do chamado podem dar touch (403 para
// outra chave).
app.post("/calls/:id/touch", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  if (c.status === "completed" || c.status === "cancelled") {
    return res.json({ ok: true, call: callPublic(c) });
  }
  const body = req.body || {};
  const key = cleanStr(body.key, 128);
  if (!callParty(c, "driver", key) && !callParty(c, "caller", key)) {
    return res.status(403).json({
      error: "not_call_party",
      message: "only a party of this call can touch it."
    });
  }
  c.updatedAt = Date.now();
  return res.json({ ok: true, call: callPublic(c) });
});

// ---------------------------------------------------------------------------
// Parte do chamado — quem e cada ponta
//
// driver: a chave da conta que aceitou o chamado. caller: a conta cujo
// telefone (so digitos) bate com o telefone do chamado. Usado pelo
// cancelamento, pelo touch e pelo chat, para so as duas pontas do
// chamado agirem nele. (O VoIP ao vivo foi removido: nao funcionou.)
// ---------------------------------------------------------------------------

// Confere se a chave pertence a ponta indicada daquele chamado.
function callParty(call, side, key) {
  if (!key) return false;
  if (side === "driver") {
    return !!call.acceptedBy && key === call.acceptedBy;
  }
  if (side === "caller") {
    const acc = findAccountById(key);
    if (!acc || !acc.phone) return false;
    return normalizePhone(call.callerPhone) === acc.phone;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Chat da corrida ("Converse com o mototaxi") — mensagens de texto
//
// Durante o chamado (aguardando ou em rota), cliente e mototaxi
// trocam mensagens de texto; o app de quem recebe LE em voz alta
// (speechSynthesis, volume maximo) para os dois ficarem atentos.
// O texto passa pelo servidor para chegar no outro aparelho (o app e
// estatico e cada aparelho so ve o proprio localStorage). A mensagem
// tambem serve para o cliente mandar o ponto de referencia ou o nome
// da rua quando o GPS nao marcou preciso.
//
// POST /calls/:id/messages { from, key, text, photo? } — envia
// (texto max 500 caracteres; foto opcional, data URL base64 ate
// 200000 caracteres — o cliente manda foto do local, da casa ou da
// referencia, e o mototaxi ve no chat dele). GET
// /calls/:id/messages?for=...&key=...&since=... —
// devolve TODAS as mensagens com seq > since (das duas pontas, em
// ordem), para o app remontar a conversa ao reabrir. So as duas
// pontas do chamado (mesma regra de parte do chamado). Fila em
// MEMORIA, descartada junto com o chamado.
// ---------------------------------------------------------------------------

const CHAT_MAX_PER_CALL = 100;
const CHAT_MAX_LEN = 500;

// id do chamado -> { seq, messages: [{ seq, from, text, at }] }
const chatMessages = new Map();

function chatPublic(m) {
  return { seq: m.seq, from: m.from, text: m.text, photo: m.photo || "", at: m.at };
}

app.post("/calls/:id/messages", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  if (c.status !== "pending" && c.status !== "accepted") {
    return res.status(409).json({
      error: "call_not_active",
      message: "messages are only available while the call is pending or accepted."
    });
  }
  const body = req.body || {};
  const from = cleanStr(body.from, 10);
  if (from !== "driver" && from !== "caller") {
    return res.status(400).json({
      error: "invalid_from",
      message: 'from must be "driver" or "caller".'
    });
  }
  const key = cleanStr(body.key, 128);
  if (!callParty(c, from, key)) {
    return res.status(403).json({
      error: "not_call_party",
      message: "this key does not belong to a party of this call."
    });
  }
  const text = cleanStr(body.text, CHAT_MAX_LEN);
  // Foto do local (opcional): o cliente manda foto da casa, do ponto
  // onde esta ou da referencia, tirada na hora pela camera ou da
  // galeria; o mototaxi ve no chat dele. Data URL JPEG/PNG/WebP em
  // base64, reduzida no aparelho; max 200000 caracteres (~150 KB)
  // para caber no limite de 256 KB do corpo JSON.
  let photo = "";
  if (typeof body.photo === "string" && body.photo.trim() !== "") {
    photo = body.photo.trim();
    if (photo.length > 200000 || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(photo)) {
      return res.status(400).json({
        error: "invalid_photo",
        message: "photo must be a data:image/jpeg|png|webp base64 URL up to 200000 characters."
      });
    }
  }
  if (!text && !photo) {
    return res
      .status(400)
      .json({ error: "missing_text", message: "text or photo is required." });
  }
  let queue = chatMessages.get(c.id);
  if (!queue) {
    queue = { seq: 0, messages: [] };
    chatMessages.set(c.id, queue);
  }
  queue.seq += 1;
  queue.messages.push({ seq: queue.seq, from, text, photo, at: Date.now() });
  // Fila limitada: descarta as mais antigas para nao crescer sem fim.
  while (queue.messages.length > CHAT_MAX_PER_CALL) queue.messages.shift();
  // Mandar mensagem mantem o chamado vivo (como o touch).
  c.updatedAt = Date.now();
  return res.status(201).json({ ok: true, seq: queue.seq });
});

app.get("/calls/:id/messages", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  const side = cleanStr(req.query.for, 10);
  if (side !== "driver" && side !== "caller") {
    return res.status(400).json({
      error: "invalid_for",
      message: 'for must be "driver" or "caller".'
    });
  }
  const key = cleanStr(req.query.key, 128);
  if (!callParty(c, side, key)) {
    return res.status(403).json({
      error: "not_call_party",
      message: "this key does not belong to a party of this call."
    });
  }
  const since = Number(req.query.since) || 0;
  const queue = chatMessages.get(c.id);
  const lastSeq = queue ? queue.seq : 0;
  const messages = [];
  if (queue) {
    for (const m of queue.messages) {
      if (m.seq > since) messages.push(chatPublic(m));
    }
  }
  return res.json({ ok: true, messages, lastSeq });
});

// ---------------------------------------------------------------------------
// Contas (/auth) — registro e login no SERVIDOR
//
// Por que no servidor: a conta antes so existia no localStorage de cada
// aparelho (mtt_contas_v1). A conta criada no celular nao existia no PC
// e o login no PC dizia "incorreto" mesmo com a senha certa. Agora a
// conta vive no servidor e o mesmo telefone + senha entra em qualquer
// aparelho; o aparelho guarda so o token da sessao (nunca a senha).
//
// Senhas: scrypt (crypto nativo) com salt aleatorio de 16 bytes;
// guardamos "salt:hash" em hexadecimal. Nada de texto claro em arquivo,
// em log ou em resposta. Comparacao com timingSafeEqual.
//
// Persistencia: accounts.json ao lado do server.js, escrita atomica
// (grava accounts.json.tmp e renomeia por cima — um corte no meio nao
// corrompe o arquivo). Lido na inicializacao; se nao existir ou estiver
// corrompido, comeca vazio e registra o aviso no log. No Render Free o
// disco e efemero (reinicio apaga o arquivo): as contas voltam pela
// migracao automatica do app, que reenvia a conta local quando o
// servidor nao a conhece. No VPS (disco persistente) nada se perde.
// O Postgres gratuito do Render NAO serve aqui: ele expira e e apagado
// depois de ~30 dias (foi o que aconteceu com o banco do Gestor), entao
// as contas sumiriam sozinhas. Quando o app for para o VPS, este mesmo
// arquivo ja e a persistencia definitiva, sem mudar nada no codigo.
//
// Admin: a primeira conta registrada no servidor vira admin
// (isAdmin=true), como antes era a primeira conta criada no aparelho.
// So o admin lista usuarios, redefine senha e apaga conta. Apagar nao
// permite apagar a propria conta nem outra conta admin.
//
// Diaria: paidUntil (fim da diaria paga, em ms) fica na conta, para a
// diaria paga valer na conta em qualquer aparelho — antes ela so valia
// no aparelho onde foi paga. O app grava via POST /auth/fee depois de
// confirmar o Pix pago (mesma validacao de antes, no aparelho).
// ---------------------------------------------------------------------------

const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // sessao vale 30 dias

let authStore = { version: 1, accounts: [], tokens: [] };

function loadAuthStore() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return;
    const raw = fs.readFileSync(ACCOUNTS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.accounts) && Array.isArray(data.tokens)) {
      authStore = data;
      pruneTokens();
    } else {
      console.log("accounts.json invalido (formato inesperado); comecando vazio.");
    }
  } catch (err) {
    console.log("nao foi possivel ler accounts.json (" + err.message + "); comecando vazio.");
  }
}

function saveAuthStore() {
  try {
    const tmp = ACCOUNTS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(authStore), "utf8");
    fs.renameSync(tmp, ACCOUNTS_FILE);
  } catch (err) {
    console.log("nao foi possivel gravar accounts.json: " + err.message);
  }
}

function normalizePhone(v) {
  if (typeof v !== "string") return "";
  return v.replace(/\D/g, "");
}

function hashPassword(password, salt) {
  const hash = crypto.scryptSync(password, salt, 64);
  return salt + ":" + hash.toString("hex");
}

function newPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return hashPassword(password, salt);
}

function checkPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const expected = Buffer.from(parts[1], "hex");
  const actual = crypto.scryptSync(password, parts[0], 64);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function accountPublic(a) {
  return {
    id: a.id,
    name: a.name,
    phone: a.phone,
    role: a.role,
    photo: a.photo || "",
    plate: a.plate || "",
    bike: a.bike || "",
    shopAddr: a.shopAddr || "",
    paidUntil: a.paidUntil || 0,
    isAdmin: !!a.isAdmin,
    createdAt: a.createdAt
  };
}

function newAccountId() {
  return "acc_" + Date.now().toString(36) + "_" + crypto.randomBytes(6).toString("hex");
}

function findAccountByPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  return authStore.accounts.find((a) => a.phone === p) || null;
}

function findAccountById(id) {
  return authStore.accounts.find((a) => a.id === id) || null;
}

function pruneTokens() {
  const now = Date.now();
  authStore.tokens = authStore.tokens.filter((t) => t.expiresAt > now);
}

function issueToken(accountId) {
  pruneTokens();
  const token = crypto.randomBytes(32).toString("hex");
  authStore.tokens.push({
    token,
    accountId,
    createdAt: Date.now(),
    expiresAt: Date.now() + TOKEN_TTL_MS
  });
  saveAuthStore();
  return token;
}

function accountFromToken(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const token = m[1].trim();
  pruneTokens();
  const rec = authStore.tokens.find((t) => t.token === token);
  if (!rec || rec.expiresAt <= Date.now()) return null;
  return findAccountById(rec.accountId);
}

function requireAuth(req, res, next) {
  const account = accountFromToken(req);
  if (!account) {
    return res.status(401).json({ error: "unauthorized", message: "valid session token is required." });
  }
  req.account = account;
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.account || !req.account.isAdmin) {
    return res.status(403).json({ error: "admin_only", message: "only the admin can do this." });
  }
  return next();
}

function revokeTokens(accountId) {
  authStore.tokens = authStore.tokens.filter((t) => t.accountId !== accountId);
}

// Limite simples contra tentativa de senha em sequencia: 10 falhas por
// telefone em 10 minutos -> 429. Em memoria; reinicio zera o contador.
const loginFailures = new Map();
function loginBlocked(phone) {
  const rec = loginFailures.get(phone);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > 10 * 60 * 1000) {
    loginFailures.delete(phone);
    return false;
  }
  return rec.count >= 10;
}
function loginFailed(phone) {
  const rec = loginFailures.get(phone) || { count: 0, firstAt: Date.now() };
  rec.count += 1;
  loginFailures.set(phone, rec);
}
function loginSucceeded(phone) {
  loginFailures.delete(phone);
}

// POST /auth/register — cria a conta no servidor. Corpo: { name, phone,
// password, role ("passageiro"|"mototaxi"|"comercio"), photo?, plate?,
// bike?, shopAddr? }. A primeira conta registrada vira admin. Se o
// telefone ja existir E a senha conferir, devolve a conta existente
// (migracao idempotente: o app reenvia a conta local sem duplicar).
app.post("/auth/register", (req, res) => {
  const body = req.body || {};
  const name = cleanStr(body.name, 80);
  const phone = normalizePhone(body.phone);
  const password = typeof body.password === "string" ? body.password : "";
  const role = cleanStr(body.role, 20);

  if (!name) {
    return res.status(400).json({ error: "missing_name", message: "name is required." });
  }
  if (!phone || phone.length < 8 || phone.length > 13) {
    return res.status(400).json({ error: "invalid_phone", message: "phone must have 8 to 13 digits." });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: "invalid_password", message: "password must have at least 4 characters." });
  }
  if (role !== "passageiro" && role !== "mototaxi" && role !== "comercio") {
    return res.status(400).json({ error: "invalid_role", message: 'role must be "passageiro", "mototaxi" or "comercio".' });
  }

  const existing = findAccountByPhone(phone);
  if (existing) {
    if (checkPassword(password, existing.passHash)) {
      // Migracao repetida: a conta ja esta no servidor, so entra.
      const token = issueToken(existing.id);
      return res.json({ ok: true, migrated: true, token, account: accountPublic(existing) });
    }
    return res.status(409).json({ error: "phone_exists", message: "this phone is already registered." });
  }

  const isAdmin = authStore.accounts.length === 0;
  const account = {
    id: newAccountId(),
    name,
    phone,
    passHash: newPasswordHash(password),
    role,
    photo: cleanStr(body.photo, 200000),
    plate: cleanStr(body.plate, 16),
    bike: cleanStr(body.bike, 80),
    shopAddr: cleanStr(body.shopAddr, 300),
    paidUntil: 0,
    isAdmin,
    createdAt: Date.now()
  };
  authStore.accounts.push(account);
  saveAuthStore();
  const token = issueToken(account.id);
  return res.status(201).json({ ok: true, token, account: accountPublic(account) });
});

// POST /auth/login — entra com telefone + senha. Erros distintos para o
// app saber o que fazer: account_not_found (conta nao existe no
// servidor — o app tenta a migracao automatica) e invalid_password.
app.post("/auth/login", (req, res) => {
  const body = req.body || {};
  const phone = normalizePhone(body.phone);
  const password = typeof body.password === "string" ? body.password : "";
  if (!phone) {
    return res.status(400).json({ error: "invalid_phone", message: "phone is required." });
  }
  if (loginBlocked(phone)) {
    return res.status(429).json({ error: "too_many_attempts", message: "too many failed attempts; try again in a few minutes." });
  }
  const account = findAccountByPhone(phone);
  if (!account) {
    return res.status(404).json({ error: "account_not_found", message: "no account for this phone." });
  }
  if (!checkPassword(password, account.passHash)) {
    loginFailed(phone);
    return res.status(401).json({ error: "invalid_password", message: "wrong password." });
  }
  loginSucceeded(phone);
  const token = issueToken(account.id);
  return res.json({ ok: true, token, account: accountPublic(account) });
});

// GET /auth/me — quem esta logado com este token.
app.get("/auth/me", requireAuth, (req, res) => {
  return res.json({ ok: true, account: accountPublic(req.account) });
});

// POST /auth/logout — encerra a sessao (apaga o token).
app.post("/auth/logout", requireAuth, (req, res) => {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (m) {
    authStore.tokens = authStore.tokens.filter((t) => t.token !== m[1].trim());
    saveAuthStore();
  }
  return res.json({ ok: true });
});

// POST /auth/change-password — o proprio usuario troca a senha.
app.post("/auth/change-password", requireAuth, (req, res) => {
  const body = req.body || {};
  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!checkPassword(current, req.account.passHash)) {
    return res.status(401).json({ error: "invalid_password", message: "current password is wrong." });
  }
  if (next.length < 4) {
    return res.status(400).json({ error: "invalid_password", message: "new password must have at least 4 characters." });
  }
  req.account.passHash = newPasswordHash(next);
  revokeTokens(req.account.id);
  saveAuthStore();
  const token = issueToken(req.account.id);
  return res.json({ ok: true, token, account: accountPublic(req.account) });
});

// POST /auth/fee — registra a diaria paga na conta (para valer em
// qualquer aparelho). Corpo: { paidUntil } (ms). So aumenta, nunca
// diminui. O app chama depois de confirmar o Pix pago.
app.post("/auth/fee", requireAuth, (req, res) => {
  const body = req.body || {};
  const paidUntil = Number(body.paidUntil);
  if (!Number.isFinite(paidUntil) || paidUntil <= Date.now()) {
    return res.status(400).json({ error: "invalid_paidUntil", message: "paidUntil must be a future timestamp." });
  }
  if (paidUntil > (req.account.paidUntil || 0)) {
    req.account.paidUntil = paidUntil;
    saveAuthStore();
  }
  return res.json({ ok: true, account: accountPublic(req.account) });
});

// GET /auth/users — admin lista as contas (para buscar pelo nome,
// redefinir senha e apagar conta). Nunca devolve o hash.
app.get("/auth/users", requireAuth, requireAdmin, (req, res) => {
  const users = authStore.accounts.map(accountPublic);
  users.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return res.json({ ok: true, users, count: users.length });
});

// POST /auth/reset-password — o admin redefine a senha de um usuario.
// Corpo: { accountId } ou { phone }, e { newPassword }. Apaga as
// sessoes do usuario (ele entra de novo com a senha nova).
app.post("/auth/reset-password", requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (newPassword.length < 4) {
    return res.status(400).json({ error: "invalid_password", message: "new password must have at least 4 characters." });
  }
  let target = null;
  if (typeof body.accountId === "string" && body.accountId) {
    target = findAccountById(body.accountId);
  }
  if (!target && body.phone) target = findAccountByPhone(body.phone);
  if (!target) {
    return res.status(404).json({ error: "account_not_found", message: "account not found." });
  }
  target.passHash = newPasswordHash(newPassword);
  revokeTokens(target.id);
  saveAuthStore();
  return res.json({ ok: true, account: accountPublic(target) });
});

// DELETE /auth/users/:id — o admin apaga uma conta. Nao apaga a
// propria conta nem outra conta admin (mesma regra de antes). Apagar
// revoga os tokens: a conta apagada perde o acesso em TODOS os
// aparelhos (o token dela deixa de valer no servidor).
app.delete("/auth/users/:id", requireAuth, requireAdmin, (req, res) => {
  const target = findAccountById(String(req.params.id || ""));
  if (!target) {
    return res.status(404).json({ error: "account_not_found", message: "account not found." });
  }
  if (target.id === req.account.id) {
    return res.status(403).json({ error: "cannot_delete_self", message: "the admin cannot delete her own account." });
  }
  if (target.isAdmin) {
    return res.status(403).json({ error: "cannot_delete_admin", message: "an admin account cannot be deleted." });
  }
  authStore.accounts = authStore.accounts.filter((a) => a.id !== target.id);
  revokeTokens(target.id);
  saveAuthStore();
  return res.json({ ok: true, deleted: target.id });
});

loadAuthStore();

app.listen(PORT, () => {
  console.log("moto-taxi-backend listening on port " + PORT);
});
