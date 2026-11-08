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
Sem diária válida (e sem isenção nem modo gratuito), o servidor
responde **402** `fee_required` — a conta da dona (isenta) e quem
pagou passam.

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

**Chamados em grupo (v1.8.0, só para passageiro):** para pedir N motos
(máx. 5) o app cria N chamados, um para cada moto, todos com o mesmo
`groupId` (string, máx. 128 caracteres), `groupIndex` de 1 a N e
`groupTotal` N. Ex.: 3 motos → 3 chamados com `groupId: "grp-..."`,
`groupIndex: 1`, `2` e `3`, `groupTotal: 3`. Cada chamado continua
independente (um aceita e vai, o outro continua pendente) e o aceite
continua atômico (o primeiro aceita, o segundo recebe 409). Sem os
campos, o chamado é avulso: `groupId: null`, `groupIndex: 1`,
`groupTotal: 1`. `groupTotal` fora de 1 a 5 ou `groupIndex` fora de 1
até `groupTotal` responde **400** `invalid_group` e **não cria nada**.
Os três campos voltam em todas as respostas que devolvem um chamado
(criar, listar, detalhe, aceitar, fase, concluir, cancelar, touch).

### GET /calls

Chamados pendentes (padrão). `?status=all` lista todos;
`?mine=<key>` lista os aceitos por aquele mototáxi (para ele
acompanhar o chamado ativo dele em qualquer aparelho);
`?callerPhone=<telefone>` lista os chamados **ativos** (pendente ou
aceito) de quem chamou — é o que o app usa ao reabrir para restaurar
o chamado/rota que estava em andamento; `?excludeCaller=<telefone>`
tira da lista os chamados feitos por aquele telefone — é o que os
motos usam para o chamado **não** aparecer para quem chamou.
Resposta: `{ "ok": true, "count": 1, "calls": [ ... ] }`.

### GET /calls/:id

Detalhe de um chamado. 404 se não existir.

### POST /calls/:id/accept

Um mototáxi aceita o chamado. Corpo: `{ "key": "...", "name": "João" }`.
Só o primeiro aceita — os outros recebem **409** e o chamado some da
lista de pendentes deles. Se o chamado foi dirigido a um moto
(`targetKey`), só ele pode aceitar (**403** para os demais). Sem
diária válida, **402** `fee_required` (a conta da dona, isenta,
aceita sem pagar).

### POST /calls/:id/phase

Atualiza a fase do chamado. Corpo: `{ "phase": "coleta_confirmada" }`
(ex.: `"a_caminho_coleta"`, `"coleta_confirmada"`,
`"a_caminho_entrega"`). Não aceita fase em chamado já concluído (409).

### POST /calls/:id/complete

Conclui o chamado. Corpo: `{ "key": "..." }`. Só o mototáxi que
aceitou pode concluir (403 para outro).

### POST /calls/:id/cancel

Cancela o chamado. Corpo: `{ "key": "..." }` (id da conta). Pode
cancelar: o **cliente** que chamou (o telefone da conta bate com o
do chamado) ou o **mototáxi** que aceitou. Quem cancela muda o
resultado: o **cliente** cancela o chamado de vez (status
`"cancelled"`, visível por 10 min e depois some); o **mototáxi** que
cancela um chamado aceito **devolve o chamado para espera** (status
`"pending"`, phase `"aguardando"`, sem mototáxi aceito, resposta com
`returnedToPending: true`) — o chamado volta a apitar para os outros
mototáxis online aceitarem, o cliente continua vendo como esperando
e o mototáxi fica livre para aceitar outro chamado. Vale em chamado
pendente ou aceito — o cliente cancela desde "procurando mototáxi" e
durante toda a espera e a rota. Cancelar de novo um chamado já
cancelado ou concluído devolve o estado atual, sem erro.

### POST /calls/:id/touch

Uma ponta avisa que ainda está com o app aberto no chamado — o app
chama a cada poll do chamado ativo, dos dois lados. Corpo:
`{ "key": "..." }`. Atualiza o `updatedAt` para o chamado não
expirar enquanto alguém está olhando. Só as duas pontas do chamado
podem dar touch (403 para outra chave).

### Chat da corrida ("Converse com o mototáxi")

Durante o chamado (aguardando ou em rota), cliente e mototáxi
trocam mensagens de texto; o app de quem recebe **lê em voz alta**
(`speechSynthesis`, volume máximo) para os dois ficarem atentos.
O texto passa pelo servidor para chegar no outro aparelho. A
mensagem também serve para o cliente mandar o ponto de referência
ou o nome da rua quando o GPS não marcou preciso.

`POST /calls/:id/messages` — envia. Corpo: `{ "from":
"driver"|"caller", "key": "<chave da conta>", "text": "...",
"photo": "data:image/jpeg;base64,..." }` (texto máx. 500 caracteres;
`photo` é opcional — o **cliente** manda foto do local, da casa ou
da referência, tirada na hora pela câmera ou escolhida da galeria, e
o mototáxi vê a foto no chat dele; a foto é reduzida no aparelho
antes de enviar, máx. 200000 caracteres). Basta texto **ou** foto.
Só vale em chamado pendente ou aceito (409 fora disso); só as duas
pontas do chamado podem trocar mensagens (403 para outra chave).

`GET /calls/:id/messages?for=driver|caller&key=<chave>&since=<seq>`
— busca as mensagens novas. Devolve **todas** as mensagens com `seq`
maior que `since` (das duas pontas, em ordem), mais `lastSeq`, para
o app remontar a conversa ao reabrir. Mandar mensagem também mantém
o chamado vivo (como o touch).

**Regra da voz:** o app lê em voz alta (voz do Google, volume
máximo) **só o que o OUTRO digitou** — o cliente digita e o mototáxi
ouve; o mototáxi digita e o cliente ouve. A voz **nunca** lê em voz
alta a própria mensagem de quem digitou (sem eco).

**VoIP ao vivo removido:** o botão de falar ao vivo (walkie-talkie,
WebRTC) foi removido porque não funcionou. Não há mais botão de voz
nem endpoints de sinalização (`/calls/:id/signal` não existe mais).
A comunicação durante a corrida é **só** pelo chat de texto acima.

Expiração: presença sem heartbeat há mais de ~15 s some da lista;
chamado pendente expira em 60 min, aceito em 180 min (3 h),
concluído/cancelado fica visível por 10 min. O chamado **não**
some quando o app fecha: o app mantém o chamado vivo com
`POST /calls/:id/touch` enquanto está aberto e, ao reabrir, busca
o chamado ativo (`GET /calls?callerPhone` para quem chamou,
`GET /calls?mine` para o mototáxi) e restaura a rota. Só cancelar
ou concluir termina o chamado.

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

**Isenção da diária (dona/admin, v1.6.0):** a conta da dona (a
primeira registrada, administradora) **não paga diária** — fica
liberada para trabalhar sem pagar nada (`feeExempt: true` na conta,
persistido em `accounts.json`, devolvido em `GET /auth/me` e em
toda resposta com a conta, junto com `feeValid`). Todos os outros
mototáxis continuam pagando a diária de R$ 5 (ou o modo gratuito
quando ligado). O servidor confere a diária em `POST /presence`
(ficar online / heartbeat) e em `POST /calls/:id/accept`: conta
conhecida sem diária válida recebe **402** `fee_required`; conta
isenta, com `paidUntil` válido ou com `freeFee` ligado passa.

**Sessão:** token aleatório (Bearer) válido por 30 dias.

### POST /auth/register

Cria a conta. Corpo: `{ "name", "phone", "password", "role":
"passageiro" | "mototaxi" | "comercio", "photo"?, "plate"?, "bike"?,
"shopAddr"? }`. Resposta (201): `{ "ok": true, "token", "account": {
"id", "name", "phone", "role", "photo", "plate", "bike", "shopAddr",
"paidUntil", "isAdmin", "feeExempt", "feeValid", "createdAt" } }`.
Telefone já registrado com a mesma senha devolve a conta existente
(migração idempotente); com senha diferente, **409** `phone_exists`.
A primeira conta registrada vira admin **e isenta da diária**
(`feeExempt: true`); as demais nascem com `feeExempt: false`.

### POST /auth/login

Entra com `{ "phone", "password" }`. Resposta: `{ "ok": true,
"token", "account" }`. Conta inexistente: **404**
`account_not_found` (o app tenta a migração automática). Senha
errada: **401** `invalid_password`. 10 falhas em 10 min por telefone:
**429** `too_many_attempts`.

### GET /auth/me

Quem está logado. Header: `Authorization: Bearer <token>`. Sem
token válido: **401** `unauthorized`. A resposta traz `feeExempt`
(só `true` para a dona) e `feeValid` (liberado: isento, `paidUntil`
válido ou modo gratuito ligado).

### POST /auth/logout

Encerra a sessão (apaga o token). Header: `Authorization: Bearer
<token>`.

### POST /auth/change-password

O próprio usuário troca a senha. Corpo: `{ "currentPassword",
"newPassword" }`. Apaga as outras sessões e devolve um token novo.

### POST /auth/fee

Registra a diária paga na conta, para valer em qualquer aparelho.
O `paidUntil` é calculado **no servidor**: agora + `feeDays` × 24 h
(v1.7.0 — antes o app mandava `paidUntil` de 24 h fixo). **Um
pagamento do valor da diária vale por `feeDays` dias.** Só aumenta,
nunca diminui. O app chama depois de confirmar o Pix pago; o corpo
não precisa de nada (um `paidUntil` mandado pelo app é ignorado).
A conta da dona (`feeExempt`) e o modo gratuito não passam por aqui.

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

Valores atuais (corrida, entrega, diária e dias de validade da
diária) para todos os aparelhos. A Administração do site grava aqui
e todos os aparelhos leem daqui, para o valor valer em todos os
aparelhos e não só onde foi editado. Responde os valores com
`settingsAt` (carimbo da alteração).

### POST /settings

A Administração grava os valores novos. Corpo com os valores e
`settingsAt` (carimbo). Só vale se o carimbo for mais recente que o
guardado; um POST mais antigo não sobrescreve o mais novo
(`stale: true`). Padrões: corrida 8, entrega 7, diária 5,
`feeDays` 1.

**Dias de validade da diária (`feeDays`, v1.7.0):** a dona escolhe
na Administração por quantos dias **um pagamento** do valor da
diária fica valendo (inteiro positivo; padrão 1, ou seja, 24 h como
antes). Com `feeDays: 7`, um pagamento de R$ 5 vale 7 dias. O
**valor** da diária só muda se ela mudar na Administração — aqui
só muda a duração. Valor inválido (0, negativo, fração ou
não-numérico) responde **400** `invalid_feeDays` e não altera nada.
Aceita também `fee_days` e `diasDiaria`.

**Modo gratuito da diária (`freeFee`):** botão/interruptor na
Administração. Com `freeFee: true`, o mototáxi trabalha **sem
pagar** a diária (sem Pix, sem trava). Com `freeFee: false` e um
valor de verdade, o Pix vale como antes (pagamento obrigatório,
`paidUntil` de `feeDays` dias). **Zerar o valor da diária sozinho não deixa
grátis** — sem a flag, a trava continua exigindo `paidUntil` e
ninguém consegue ficar online. Aceita também `free_fee`, `free`,
`diariaGratis` e `gratis`.

## Endpoints Pix

### GET /

Saúde do serviço. Responde `{ ok: true, service: "moto-taxi-backend", version: "1.8.2" }`.

## Changelog

- **v1.8.2** — áudio do chat aceita parâmetros MIME (`;codecs=opus`):
  o MediaRecorder do Chrome/Android produz
  `data:audio/webm;codecs=opus;base64,...` e o regex anterior
  rejeitava com 400 `invalid_audio` — o áudio "enviado" nunca era
  salvo. Nenhuma outra mudança de comportamento.
- **v1.8.1** — cancelamento pelo mototáxi devolve o chamado para
  espera: `POST /calls/:id/cancel` pelo mototáxi que aceitou volta o
  chamado para `"pending"` / `"aguardando"` (com
  `returnedToPending: true`); o cancelamento pelo cliente continua
  cancelando o chamado de vez.
- **v1.8.0** — chamados em grupo (só passageiro): `POST /calls`
  aceita `groupId`, `groupIndex` e `groupTotal` (1 a 5); os três
  campos voltam em todas as respostas de chamado; `groupTotal` ou
  `groupIndex` inválido responde 400 `invalid_group` sem criar nada.
- **v1.7.0** — dias de validade da diária configuráveis (`feeDays`).

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
