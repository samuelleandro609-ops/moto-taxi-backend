# moto-taxi-backend

Backend do **Moto Taxi Timbauba**. Cria cobranças Pix via Mercado Pago.

## Para que serve

**Só a diária do mototáxi (R$ 5)** — é o que o mototáxi paga à dona para
rodar no app. O comércio **não paga nada** a ela e não usa este backend:
o comércio paga a entrega (R$ 7) direto ao entregador, e o passageiro
paga a corrida (R$ 8) direto ao mototáxi, no Pix dele ou em dinheiro.
Não há saldo nem saque dentro do app.

O endpoint `/create-pix` é genérico (aceita qualquer valor e descrição),
mas o único uso dele hoje é a diária.

## Endpoints

### GET /

Saúde do serviço. Responde `{ ok: true, service: "moto-taxi-backend", version: "1.0.0" }`.

### POST /create-pix

Cria uma cobrança Pix no Mercado Pago.

Corpo (JSON):

```json
{
  "amount": 5,
  "description": "Diária Moto Táxi Timbaúba",
  "external_ref": "diaria-81-99999-0000-2026-11-07",
  "payer_email": "motorista@exemplo.com"
}
```

Resposta (201):

```json
{
  "id": 123456789,
  "status": "pending",
  "qr_code": "00020126...",
  "qr_code_base64": "iVBORw0KGgo...",
  "ticket_url": "https://www.mercadopago.com.br/payments/123456789/ticket"
}
```

Validação: `amount` tem que ser número positivo; `description`,
`external_ref` e `payer_email` são obrigatórios (e-mail válido).
Se faltar algo, responde **400**. Se o token não estiver configurado,
responde **503** e **nunca** gera QR falso.

### GET /payment/:id

Consulta o status de uma cobrança no Mercado Pago. Responde:

```json
{
  "id": 123456789,
  "status": "approved",
  "status_detail": "accredited",
  "transaction_amount": 5,
  "external_reference": "diaria-81-99999-0000-2026-11-07"
}
```

## Variável de ambiente (obrigatória)

| Variável | O que é |
| --- | --- |
| `MP_ACCESS_TOKEN` | Token de acesso (Access Token) do Mercado Pago da dona. **Nunca** coloque o token no código, no repositório ou em log. |

No Render: **Dashboard do serviço → Environment → Add Environment
Variable → MP_ACCESS_TOKEN = o Access Token** (começa com `APP_USR-`
em produção). Depois salve — o Render reinicia o serviço sozinho.
Sem essa variável, `/create-pix` responde 503.

`ALLOWED_ORIGIN` é opcional (padrão: `https://moto-taxi-timbauba.onrender.com`).

## Rodar local

```bash
npm install
MP_ACCESS_TOKEN=SEU_TOKEN npm start
```

O serviço escuta na porta `PORT` (ou 3000). Sem `MP_ACCESS_TOKEN`,
sobe normalmente, mas `/create-pix` responde 503.

## Deploy no Render

1. Suba este código para o repositório GitHub `samuelleandro609-ops/moto-taxi-backend` (público).
2. No Render, crie um **Web Service** (Free) conectado a esse repositório
   (ou use o `render.yaml` como Blueprint).
3. Build Command: `npm install` — Start Command: `npm start`.
4. Em **Environment**, crie `MP_ACCESS_TOKEN` com o Access Token.
5. O serviço fica em `https://moto-taxi-backend.onrender.com` (ou o
   endereço que o Render gerar). No plano Free ele dorme após ~15 min
   sem acesso; a primeira chamada pode demorar alguns segundos.

## Segurança

- O token só existe como variável de ambiente no Render. O site (estático)
  nunca vê o token: ele chama este backend, que chama o Mercado Pago.
- CORS só permite o site `https://moto-taxi-timbauba.onrender.com`.
