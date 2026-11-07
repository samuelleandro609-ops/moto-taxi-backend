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
 */

const express = require("express");

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
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
  res.json({ ok: true, service: "moto-taxi-backend", version: "1.2.0" });
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

const DEFAULT_SETTINGS = { ride: 8, delivery: 7, fee: 5 };
let appSettings = { ...DEFAULT_SETTINGS, settingsAt: 0 };

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
  const at = pickNumber(body, ["settingsAt", "updatedAt", "timestamp", "version"]);

  if (ride === undefined && delivery === undefined && fee === undefined) {
    return res.status(400).json({
      error: "invalid_settings",
      message: "at least one of ride, delivery or fee must be a number >= 0."
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
const CALL_PENDING_TTL_MS = 30 * 60 * 1000; // chamado pendente expira em 30 min
const CALL_ACTIVE_TTL_MS = 60 * 60 * 1000; // aceito expira em 60 min
const CALL_DONE_TTL_MS = 10 * 60 * 1000; // concluido fica visivel por 10 min

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
    if (now - c.updatedAt > ttl) calls.delete(id);
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
// o chamado ativo dele em qualquer aparelho).
app.get("/calls", (req, res) => {
  pruneStores();
  const status = cleanStr(req.query.status, 20) || "pending";
  const mine = cleanStr(req.query.mine, 128);
  const list = [];
  for (const c of calls.values()) {
    if (mine) {
      if (c.acceptedBy !== mine) continue;
    } else if (status !== "all" && c.status !== status) {
      continue;
    }
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

app.listen(PORT, () => {
  console.log("moto-taxi-backend listening on port " + PORT);
});
