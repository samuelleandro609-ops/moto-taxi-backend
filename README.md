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

### Voz ao vivo — sinalização WebRTC (push-to-talk)

Durante a rota ativa, o mototáxi segura um botão para falar e o
cliente ouve ao vivo (walkie-talkie, só moto → cliente). O servidor
só faz a **sinalização**: guarda e entrega as mensagens do "combinado"
da ligação (oferta SDP, resposta SDP e candidatos ICE). O áudio vai
direto de navegador para navegador (peer-to-peer via WebRTC) e **não**
passa pelo servidor. O botão só existe durante a rota ativa; quando
ela acaba, as duas pontas fecham a conexão.

`POST /calls/:id/signal` — uma ponta envia um sinal para a outra.
Corpo: `{ "from": "driver"|"caller", "key": "<chave da conta>",
"type": "offer"|"answer"|"ice"|"bye", "data": {...} }`. Só vale em
chamado aceito (409 fora da rota ativa); só as duas pontas do chamado
podem trocar sinais (403 para outra chave). `offer` é a oferta SDP do
mototáxi, `answer` a resposta SDP do cliente, `ice` um candidato ICE
de qualquer ponta e `bye` avisa que a ponta fechou a conexão.

`GET /calls/:id/signal?for=driver|caller&key=<chave>&since=<seq>` —
uma ponta busca os sinais novos para ela. Devolve só as mensagens da
outra ponta com `seq` maior que `since`, em ordem, mais `lastSeq`.
Cada ponta guarda o último `seq` recebido e pergunta de tempos em
tempos (polling, como o resto do app).

Expiração: presença sem heartbeat há mais de ~15 s some da lista;
chamado pendente expira em 30 min, aceito em 60 min, concluído fica
visível por 10 min.

## Contas no servidor (/auth)

Antes a conta só existia no `localStorage` de cada aparelho: a conta
criada no celular não existia no PC e o login no PC dizia "incorreto"
mesmo com a senha certa. Agora registro e login são no servidor — o
mesmo telefone + senha entra em qualquer aparelho; o aparelho guarda
só o token da sessão (nunca a senha).

**Senhas:** hash `scrypt` com salt aleatório (crypto nativo, sem
dependência nova). Nada de texto claro em arquivo, log ou resposta.

**Persistência:** `accounts.json` ao lado do `server.js`, escrita
atômica (grava temporário e renomeia). Lido na inicialização. No
Render Free o disco é efêmero — se o serviço reiniciar, o arquivo
some e as contas voltam pela migração automática do app (ele reenvia
a conta local quando o servidor não a conhece). No VPS o disco
persiste e nada se perde. O Postgres gratuito do Render **não** serve:
ele expira e é apagado depois de ~30 dias.

**Admin:** a primeira conta registrada no servidor vira admin
(`isAdmin: true`). Só o admin lista usuários, redefine senha e apaga
conta. Apagar não permite apagar a própria conta nem outra admin — e
revoga os tokens da conta apagada, então ela perde o acesso em todos
os aparelhos.

**Sessão:** token aleatório (Bearer) válido por 30 dias.

### POST /auth/register

Cria a conta. Corpo: `{ "name", "phone", "password", "role":
"passageiro" | "mototaxi" | "comercio", "photo"?, "plate"?, "bike"?,
"shopAddr"? }`. Resposta (201): `{ "ok": true, "token", "account": {
"id", "name", "phone", "role", "photo", "plate", "bike", "shopAddr",
"paidUntil", "isAdmin", "createdAt" } }`. Telefone já registrado com
a mesma senha devolve a conta existente (migração idempotente);
com senha diferente, **409** `phone_exists`.

### POST /auth/login

Entra com `{ "phone", "password" }`. Resposta: `{ "ok": true,
"token", "account" }`. Conta inexistente: **404**
`account_not_found` (o app tenta a migração automática). Senha
errada: **401** `invalid_password`. 10 falhas em 10 min por telefone:
**429** `too_many_attempts`.

### GET /auth/me

Quem está logado. Header: `Authorization: Bearer <token>`. Sem
token válido: **401** `unauthorized`.

### POST /auth/logout

Encerra a sessão (apaga o token). Header: `Authorization: Bearer
<token>`.

### POST /auth/change-password

O próprio usuário troca a senha. Corpo: `{ "currentPassword",
"newPassword" }`. Apaga as outras sessões e devolve um token novo.

### POST /auth/fee

Registra a diária paga na conta, para valer em qualquer aparelho.
Corpo: `{ "paidUntil" }` (timestamp em ms, no futuro). Só aumenta,
nunca diminui. O app chama depois de confirmar o Pix pago.

### GET /auth/users

Admin lista as contas (buscar pelo nome, redefinir senha, apagar
conta). Não-admin: **403** `admin_only`.

### POST /auth/reset-password

O admin redefine a senha de um usuário. Corpo: `{ "accountId" }` ou
`{ "phone" }`, e `{ "newPassword" }`. Apaga as sessões do usuário.

### DELETE /auth/users/:id

O admin apaga uma conta. Não apaga a própria conta nem outra admin
(**403**). Revoga os tokens da conta apagada.

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

Saúde do serviço. Responde `{ ok: true, service: "moto-taxi-backend", version: "1.4.0" }`.

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
