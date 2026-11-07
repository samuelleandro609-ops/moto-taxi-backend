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
    const resp = await fetch(MP_API + path, {
      method: (options && options.method) || "GET",
      body: options && options.body ? options.body : undefined,
      signal: controller.signal,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      }
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
  res.json({ ok: true, service: "moto-taxi-backend", version: "1.0.0" });
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

app.listen(PORT, () => {
  console.log("moto-taxi-backend listening on port " + PORT);
});
