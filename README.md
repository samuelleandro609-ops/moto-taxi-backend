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

## Sincronização entre aparelhos (presença e chamados)

O site é estático: cada aparelho só vê o próprio `localStorage`. Estes
endpoints guardam em **memória** quem está online e quais chamados estão
pendentes, para que qualquer aparelho veja o mesmo estado — nos **dois
sentidos**: um celular online aparece no PC e um PC online aparece no
celular; um chamado feito em qualquer aparelho chega ao mototáxi em
qualquer aparelho. Sem banco de dados: se o serviço reiniciar (o plano
Free do Render dorme após ~15 min sem acesso), presença e chamados
somem e os aparelhos reenviam o heartbeat / recriam o chamado.

### POST /presence

Heartbeat do mototáxi — o app envia a cada poucos segundos enquanto ele
está online. Corpo:

```json
{
  "key": "conta-telefone-do-mototaxi",
  "name": "João",
  "photo": "data:image/jpeg;base64,...",
  "bike": "Honda CG 160",
  "plate": "ABC1D23",
  "lat": -7.4744,
  "lng": -35.3436,
  "online": true
}
```

Resposta: `{ "ok": true, "online": true, "key": "..." }`. Com
`"online": false` o moto sai da lista na hora. A foto é opcional nos
heartbeats seguintes — sem ela, o servidor mantém a última foto.

### GET /presence

Motos online agora — só as com heartbeat nos últimos **15 segundos**.
Resposta:

```json
{
  "ok": true,
  "count": 1,
  "drivers": [
    { "key": "...", "name": "João", "photo": "data:image/jpeg;base64,...", "bike": "Honda CG 160", "plate": "ABC1D23", "lat": -7.4744, "lng": -35.3436, "updatedAt": 1792450000000 }
  ]
}
```

### POST /calls

Cria um chamado. `targetKey: null` = para qualquer moto;
com `targetKey` o chamado é dirigido a um moto só (o "Chamar" ao
clicar no moto no mapa). Corpo:

```json
{
  "callerName": "Maria",
  "callerPhone": "81999990000",
  "targetKey": null,
  "targetName": null,
  "type": "corrida",
  "pickup": "Rua da Matriz, 100",
  "destination": "Rua do Comércio, 50",
  "amount": 8
}
```

`type` é `"corrida"` ou `"entrega"`. Resposta (201): `{ "ok": true, "call": { "id": "call_...", "status": "pending", "phase": "aguardando", ... } }`.

### GET /calls

Chamados pendentes (padrão). `?status=all` lista todos;
`?mine=<key>` lista os aceitos por aquele mototáxi (para ele
acompanhar o chamado ativo dele em qualquer aparelho). Resposta:
`{ "ok": true, "count": 1, "calls": [ ... ] }`.

### GET /calls/:id

Detalhe de um chamado. 404 se não existir.

### POST /calls/:id/accept

Um mototáxi aceita o chamado. Corpo: `{ "key": "...", "name": "João" }`.
Só o primeiro aceita — os outros recebem **409** e o chamado some da
lista de pendentes deles. Se o chamado foi dirigido a um moto
(`targetKey`), só ele pode aceitar (**403** para os demais).

### POST /calls/:id/phase

Atualiza a fase do chamado. Corpo: `{ "phase": "coleta_confirmada" }`
(ex.: `"a_caminho_coleta"`, `"coleta_confirmada"`,
`"a_caminho_entrega"`). Não aceita fase em chamado já concluído (409).

### POST /calls/:id/complete

Conclui o chamado. Corpo: `{ "key": "..." }`. Só o mototáxi que
aceitou pode concluir (403 para outro).

Expiração: presença sem heartbeat há mais de ~15 s some da lista;
chamado pendente expira em 30 min, aceito em 60 min, concluído fica
visível por 10 min.

## Endpoints de valores

### GET /settings

Valores atuais (corrida, entrega, diária) para todos os aparelhos.
A Administração do site grava aqui e todos os aparelhos leem daqui,
para o valor valer em todos os aparelhos e não só onde foi editado.
Responde os valores com `settingsAt` (carimbo da alteração).

### POST /settings

A Administração grava os valores novos. Corpo com os valores e
`settingsAt` (carimbo). Só vale se o carimbo for mais recente que o
guardado; um POST mais antigo não sobrescreve o mais novo
(`stale: true`). Padrões: corrida 8, entrega 7, diária 5.

## Endpoints Pix

### GET /

Saúde do serviço. Responde `{ ok: true, service: "moto-taxi-backend", version: "1.2.0" }`.

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
