"use strict";

/**
 * test-local.js — testes locais do moto-taxi-backend (v1.8.3).
 *
 * Sobe o server.js numa porta de teste (PORT=3101) e testa por HTTP.
 * NAO chama nenhum endpoint /auth/* — os testes nunca tocam no
 * accounts.json real. O aceite usa chaves desconhecidas ("test-key-1",
 * "test-key-2"): conta desconhecida passa na checagem de diaria como
 * antes (so conta CONHECIDA sem diaria valida recebe 402).
 *
 * Uso: node test-local.js        (sai 0 se tudo passar, 1 se falhar)
 */

const { spawn } = require("child_process");
const path = require("path");

const PORT = 3101;
const BASE = "http://127.0.0.1:" + PORT;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log("  PASS " + name);
  } else {
    failed += 1;
    failures.push(name + (extra ? " — " + extra : ""));
    console.log("  FAIL " + name + (extra ? " — " + extra : ""));
  }
}

async function req(method, p, body) {
  const resp = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    data = null;
  }
  return { status: resp.status, data };
}

function baseCall(overrides) {
  return Object.assign(
    {
      callerName: "Teste",
      callerPhone: "81999990000",
      targetKey: null,
      targetName: null,
      type: "corrida",
      pickup: "Rua A, 100",
      destination: "Rua B, 50",
      amount: 8
    },
    overrides || {}
  );
}

async function waitReady(child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await req("GET", "/");
      if (r.status === 200 && r.data && r.data.ok) return true;
    } catch (e) {
      // servidor ainda subindo
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function run() {
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOut = "";
  child.stdout.on("data", (d) => {
    serverOut += d.toString();
  });
  child.stderr.on("data", (d) => {
    serverOut += d.toString();
  });

  try {
    if (!(await waitReady(child))) {
      console.log("FAIL servidor nao subiu na porta " + PORT);
      console.log(serverOut);
      process.exitCode = 1;
      return;
    }

    // (g) regressao: versao e settings
    console.log("== regressao: versao e settings ==");
    const root = await req("GET", "/");
    check("GET / retorna version 1.8.3", root.status === 200 && root.data && root.data.version === "1.8.3", JSON.stringify(root.data));
    const settings = await req("GET", "/settings");
    check("GET /settings traz feeDays 1", settings.status === 200 && settings.data && settings.data.feeDays === 1, JSON.stringify(settings.data));

    // (a) criar sem campos de grupo -> padroes
    console.log("== (a) chamado sem grupo: padroes ==");
    const plain = await req("POST", "/calls", baseCall());
    check(
      "criar sem grupo devolve 201 com groupId null, groupIndex 1, groupTotal 1",
      plain.status === 201 &&
        plain.data.call.groupId === null &&
        plain.data.call.groupIndex === 1 &&
        plain.data.call.groupTotal === 1,
      JSON.stringify(plain.data)
    );
    const plainId = plain.data && plain.data.call && plain.data.call.id;

    // (b) criar com grupo -> campos guardados e devolvidos
    console.log("== (b) chamado com grupo ==");
    const grouped = await req(
      "POST",
      "/calls",
      baseCall({ groupId: "grp-teste-1", groupIndex: 2, groupTotal: 3 })
    );
    check(
      "criar com grupo devolve 201 com os campos guardados",
      grouped.status === 201 &&
        grouped.data.call.groupId === "grp-teste-1" &&
        grouped.data.call.groupIndex === 2 &&
        grouped.data.call.groupTotal === 3,
      JSON.stringify(grouped.data)
    );
    const groupedId = grouped.data && grouped.data.call && grouped.data.call.id;
    const byId = await req("GET", "/calls/" + groupedId);
    check(
      "GET /calls/:id devolve os campos do grupo",
      byId.status === 200 &&
        byId.data.call.groupId === "grp-teste-1" &&
        byId.data.call.groupIndex === 2 &&
        byId.data.call.groupTotal === 3,
      JSON.stringify(byId.data)
    );
    const list = await req("GET", "/calls");
    const listed = (list.data.calls || []).find((c) => c.id === groupedId);
    check(
      "GET /calls lista o chamado com os campos do grupo",
      !!listed && listed.groupId === "grp-teste-1" && listed.groupIndex === 2 && listed.groupTotal === 3,
      JSON.stringify(list.data)
    );

    // (c) groupTotal invalido -> 400 e nada criado
    console.log("== (c) groupTotal invalido ==");
    const before = await req("GET", "/calls?status=all");
    const countBefore = before.data.count;
    for (const bad of [0, 6, 2.5]) {
      const r = await req("POST", "/calls", baseCall({ groupTotal: bad }));
      check(
        "groupTotal " + bad + " -> 400 invalid_group",
        r.status === 400 && r.data && r.data.error === "invalid_group",
        "status=" + r.status + " " + JSON.stringify(r.data)
      );
    }
    const after = await req("GET", "/calls?status=all");
    check(
      "nada criado apos groupTotal invalido (count igual)",
      after.data.count === countBefore,
      "antes=" + countBefore + " depois=" + after.data.count
    );

    // (d) groupIndex invalido -> 400
    console.log("== (d) groupIndex invalido ==");
    for (const bad of [
      { groupIndex: 0, groupTotal: 3 },
      { groupIndex: 4, groupTotal: 3 },
      { groupIndex: 2 }, // sem groupTotal: total padrao 1, indice 2 invalido
      { groupIndex: 6, groupTotal: 5 }
    ]) {
      const r = await req("POST", "/calls", baseCall(bad));
      check(
        "groupIndex " + JSON.stringify(bad) + " -> 400 invalid_group",
        r.status === 400 && r.data && r.data.error === "invalid_group",
        "status=" + r.status + " " + JSON.stringify(r.data)
      );
    }
    const after2 = await req("GET", "/calls?status=all");
    check(
      "nada criado apos groupIndex invalido (count igual)",
      after2.data.count === countBefore,
      "antes=" + countBefore + " depois=" + after2.data.count
    );

    // (e) corrida de aceite: dois accepts ao mesmo tempo
    console.log("== (e) corrida de aceite ==");
    const race = await req("POST", "/calls", baseCall({ groupId: "grp-corrida", groupIndex: 1, groupTotal: 2 }));
    const raceId = race.data.call.id;
    const results = await Promise.all([
      req("POST", "/calls/" + raceId + "/accept", { key: "test-key-1", name: "Moto 1" }),
      req("POST", "/calls/" + raceId + "/accept", { key: "test-key-2", name: "Moto 2" })
    ]);
    const statuses = results.map((r) => r.status).sort();
    const ok200 = results.find((r) => r.status === 200);
    const err409 = results.find((r) => r.status === 409);
    check(
      "dois accepts simultaneos: exatamente um 200 e um 409",
      statuses[0] === 200 && statuses[1] === 409,
      "statuses=" + JSON.stringify(statuses)
    );
    check(
      "o 409 traz error call_not_pending",
      !!err409 && err409.data && err409.data.error === "call_not_pending",
      JSON.stringify(err409 && err409.data)
    );
    check(
      "a resposta do aceite (200) traz os campos do grupo",
      !!ok200 &&
        ok200.data.call.groupId === "grp-corrida" &&
        ok200.data.call.groupIndex === 1 &&
        ok200.data.call.groupTotal === 2,
      JSON.stringify(ok200 && ok200.data)
    );
    // Libera o vencedor da corrida: conclui o chamado para (g) nao
    // depender de quem ganhou (com a regra de um chamado por moto,
    // quem ainda tem um chamado aceito nao aceitaria outro).
    const raceDone = await req("POST", "/calls/" + raceId + "/complete", { key: ok200.data.call.acceptedBy });
    check(
      "vencedor da corrida conclui o chamado (libera para aceitar outro)",
      raceDone.status === 200 && raceDone.data.call.status === "completed",
      JSON.stringify(raceDone.data)
    );

    // (f) chamado aceito some da lista de pendentes
    console.log("== (f) aceito some dos pendentes ==");
    const pending = await req("GET", "/calls");
    check(
      "chamado aceito nao esta em GET /calls (pendentes)",
      !(pending.data.calls || []).some((c) => c.id === raceId),
      JSON.stringify(pending.data)
    );
    const mine = await req("GET", "/calls?mine=" + (ok200.data.call.acceptedBy || ""));
    check(
      "chamado aceito aparece em GET /calls?mine=<aceitou>",
      (mine.data.calls || []).some((c) => c.id === raceId),
      JSON.stringify(mine.data)
    );

    // (g) regressao: fluxo criar/aceitar/fase/concluir e criar/aceitar/cancelar
    console.log("== (g) regressao: fluxo completo ==");
    const c1 = await req("POST", "/calls", baseCall());
    const c1id = c1.data.call.id;
    const a1 = await req("POST", "/calls/" + c1id + "/accept", { key: "test-key-1", name: "Moto 1" });
    check("fluxo: accept devolve 200 accepted", a1.status === 200 && a1.data.call.status === "accepted", JSON.stringify(a1.data));
    const ph = await req("POST", "/calls/" + c1id + "/phase", { phase: "coleta_confirmada" });
    check(
      "fluxo: phase devolve 200 com a fase e os campos do grupo",
      ph.status === 200 && ph.data.call.phase === "coleta_confirmada" && ph.data.call.groupTotal === 1,
      JSON.stringify(ph.data)
    );
    const done = await req("POST", "/calls/" + c1id + "/complete", { key: "test-key-1" });
    check("fluxo: complete devolve 200 completed", done.status === 200 && done.data.call.status === "completed", JSON.stringify(done.data));

    const c2 = await req("POST", "/calls", baseCall({ groupId: "grp-cancel", groupIndex: 1, groupTotal: 2 }));
    const c2id = c2.data.call.id;
    const a2 = await req("POST", "/calls/" + c2id + "/accept", { key: "test-key-1", name: "Moto 1" });
    check("fluxo: segundo accept devolve 200", a2.status === 200, JSON.stringify(a2.data));
    const cx = await req("POST", "/calls/" + c2id + "/cancel", { key: "test-key-1" });
    check(
      "fluxo: cancel do mototaxi devolve 200 com o chamado em espera",
      cx.status === 200 &&
        cx.data.call.status === "pending" &&
        cx.data.call.phase === "aguardando" &&
        cx.data.call.groupId === "grp-cancel" &&
        cx.data.returnedToPending === true,
      JSON.stringify(cx.data)
    );

    // (h) um mototaxi so aceita UM chamado
    console.log("== (h) um mototaxi so aceita UM chamado ==");
    const h1 = await req("POST", "/calls", baseCall({ groupId: "grp-um-so", groupIndex: 1, groupTotal: 2 }));
    const h1id = h1.data.call.id;
    const h2 = await req("POST", "/calls", baseCall({ groupId: "grp-um-so", groupIndex: 2, groupTotal: 2 }));
    const h2id = h2.data.call.id;
    const ha1 = await req("POST", "/calls/" + h1id + "/accept", { key: "test-key-h1", name: "Moto H1" });
    check("h1 aceita o chamado 1 -> 200", ha1.status === 200 && ha1.data.call.status === "accepted", JSON.stringify(ha1.data));
    const ha2 = await req("POST", "/calls/" + h2id + "/accept", { key: "test-key-h1", name: "Moto H1" });
    check(
      "h1 tenta aceitar o chamado 2 -> 409 driver_already_has_call",
      ha2.status === 409 && ha2.data && ha2.data.error === "driver_already_has_call",
      "status=" + ha2.status + " " + JSON.stringify(ha2.data)
    );
    const hb2 = await req("POST", "/calls/" + h2id + "/accept", { key: "test-key-h2", name: "Moto H2" });
    check("h2 aceita o chamado 2 -> 200", hb2.status === 200 && hb2.data.call.status === "accepted", JSON.stringify(hb2.data));
    const hd1 = await req("POST", "/calls/" + h1id + "/complete", { key: "test-key-h1" });
    check("h1 conclui o chamado 1 -> 200", hd1.status === 200 && hd1.data.call.status === "completed", JSON.stringify(hd1.data));
    const h3 = await req("POST", "/calls", baseCall());
    const h3id = h3.data.call.id;
    const ha3 = await req("POST", "/calls/" + h3id + "/accept", { key: "test-key-h1", name: "Moto H1" });
    check("h1 livre apos concluir aceita outro chamado -> 200", ha3.status === 200, JSON.stringify(ha3.data));
    const hx2 = await req("POST", "/calls/" + h2id + "/cancel", { key: "test-key-h2" });
    check("h2 cancela o chamado 2 -> 200 em espera", hx2.status === 200 && hx2.data.call.status === "pending" && hx2.data.returnedToPending === true, JSON.stringify(hx2.data));
    const h4 = await req("POST", "/calls", baseCall());
    const h4id = h4.data.call.id;
    const ha4 = await req("POST", "/calls/" + h4id + "/accept", { key: "test-key-h2", name: "Moto H2" });
    check("h2 livre apos cancelar aceita outro chamado -> 200", ha4.status === 200, JSON.stringify(ha4.data));

    // (i) chat so audio: audio gravado vai pelo servidor e volta no polling
    console.log("== (i) chat: audio gravado ==");
    const ac = await req("POST", "/calls", baseCall());
    const acid = ac.data.call.id;
    const aa = await req("POST", "/calls/" + acid + "/accept", { key: "test-key-audio", name: "Moto Audio" });
    check("audio: accept do chamado -> 200", aa.status === 200, JSON.stringify(aa.data));
    const fakeAudio = "data:audio/webm;base64," + "AAAA".repeat(1000);
    const am = await req("POST", "/calls/" + acid + "/messages", { from: "driver", key: "test-key-audio", audio: fakeAudio, durationSec: 12 });
    check("audio: enviar audio -> 201", am.status === 201, "status=" + am.status + " " + JSON.stringify(am.data));
    const gm = await req("GET", "/calls/" + acid + "/messages?for=driver&key=test-key-audio&since=0");
    const got = (gm.data.messages || []).find((m) => m.audio === fakeAudio);
    check(
      "audio: GET messages devolve o audio com durationSec",
      gm.status === 200 && !!got && got.durationSec === 12 && got.from === "driver",
      JSON.stringify(gm.data)
    );
    // v1.8.2: o MediaRecorder do Chrome/Android produz
    // data:audio/webm;codecs=opus;base64,... — o regex antigo
    // rejeitava com 400 invalid_audio e o audio "enviado" nunca
    // era salvo. O formato com parametros MIME tem que aceitar e
    // voltar no polling igual ao formato simples.
    const codecsAudio = "data:audio/webm;codecs=opus;base64," + "AAAA".repeat(1000);
    const amc = await req("POST", "/calls/" + acid + "/messages", { from: "driver", key: "test-key-audio", audio: codecsAudio, durationSec: 8 });
    check("audio: enviar audio com ;codecs=opus -> 201", amc.status === 201, "status=" + amc.status + " " + JSON.stringify(amc.data));
    const gmc = await req("GET", "/calls/" + acid + "/messages?for=driver&key=test-key-audio&since=0");
    const gotc = (gmc.data.messages || []).find((m) => m.audio === codecsAudio);
    check(
      "audio: GET messages devolve o audio com codecs e durationSec",
      gmc.status === 200 && !!gotc && gotc.durationSec === 8 && gotc.from === "driver",
      JSON.stringify(gmc.data)
    );
    const bigAudio = "data:audio/webm;base64," + "A".repeat(200001);
    const ab = await req("POST", "/calls/" + acid + "/messages", { from: "driver", key: "test-key-audio", audio: bigAudio, durationSec: 60 });
    check(
      "audio: audio grande demais -> 400 invalid_audio",
      ab.status === 400 && ab.data && ab.data.error === "invalid_audio",
      "status=" + ab.status + " " + JSON.stringify(ab.data)
    );
    const badAudio = await req("POST", "/calls/" + acid + "/messages", { from: "driver", key: "test-key-audio", audio: "data:text/plain;base64,AAAA", durationSec: 5 });
    check(
      "audio: mime que nao e audio -> 400 invalid_audio",
      badAudio.status === 400 && badAudio.data && badAudio.data.error === "invalid_audio",
      "status=" + badAudio.status + " " + JSON.stringify(badAudio.data)
    );
    const noContent = await req("POST", "/calls/" + acid + "/messages", { from: "driver", key: "test-key-audio" });
    check(
      "audio: mensagem sem conteudo -> 400 missing_content",
      noContent.status === 400 && noContent.data && noContent.data.error === "missing_content",
      "status=" + noContent.status + " " + JSON.stringify(noContent.data)
    );
    const phMsg = await req("POST", "/calls/" + acid + "/messages", { from: "driver", key: "test-key-audio", photo: "data:image/jpeg;base64,/9j/AAAA" });
    check("audio: foto continua funcionando -> 201", phMsg.status === 201, "status=" + phMsg.status + " " + JSON.stringify(phMsg.data));

    // (j) cancelamento pelo mototaxi devolve o chamado para espera
    // (v1.8.1): o chamado nao some — volta para pendente, continua
    // apitando (reaparece em GET /calls) e o cliente continua vendo
    // como esperando; o moto fica livre e outro moto pode aceitar.
    console.log("== (j) mototaxi cancela -> chamado volta para espera ==");
    const j1 = await req("POST", "/calls", baseCall({ groupId: "grp-volta", groupIndex: 1, groupTotal: 2 }));
    const j1id = j1.data.call.id;
    const ja1 = await req("POST", "/calls/" + j1id + "/accept", { key: "test-key-j1", name: "Moto J1" });
    check("j: moto J1 aceita -> 200", ja1.status === 200 && ja1.data.call.status === "accepted", JSON.stringify(ja1.data));
    const jc1 = await req("POST", "/calls/" + j1id + "/cancel", { key: "test-key-j1" });
    check(
      "j: moto J1 cancela -> 200 pending/aguardando, sem moto aceito, returnedToPending",
      jc1.status === 200 &&
        jc1.data.call.status === "pending" &&
        jc1.data.call.phase === "aguardando" &&
        jc1.data.call.acceptedBy === null &&
        jc1.data.call.acceptedName === null &&
        jc1.data.returnedToPending === true,
      JSON.stringify(jc1.data)
    );
    const jlist = await req("GET", "/calls");
    check(
      "j: chamado devolvido aparece de novo em GET /calls (pendentes)",
      (jlist.data.calls || []).some((c) => c.id === j1id),
      JSON.stringify(jlist.data)
    );
    const jcaller = await req("GET", "/calls?callerPhone=81999990000");
    const jseen = (jcaller.data.calls || []).find((c) => c.id === j1id);
    check(
      "j: cliente continua vendo o chamado como esperando",
      !!jseen && jseen.status === "pending",
      JSON.stringify(jcaller.data)
    );
    const j2 = await req("POST", "/calls", baseCall());
    const j2id = j2.data.call.id;
    const ja2 = await req("POST", "/calls/" + j2id + "/accept", { key: "test-key-j1", name: "Moto J1" });
    check("j: J1 livre apos cancelar aceita outro chamado -> 200", ja2.status === 200 && ja2.data.call.status === "accepted", JSON.stringify(ja2.data));
    const ja3 = await req("POST", "/calls/" + j1id + "/accept", { key: "test-key-j2", name: "Moto J2" });
    check("j: outro moto aceita o chamado devolvido -> 200", ja3.status === 200 && ja3.data.call.status === "accepted", JSON.stringify(ja3.data));
    const jc2 = await req("POST", "/calls/" + j1id + "/cancel", { key: "test-key-j2" });
    check(
      "j: segundo cancelamento do moto tambem devolve para espera",
      jc2.status === 200 && jc2.data.call.status === "pending" && jc2.data.returnedToPending === true,
      JSON.stringify(jc2.data)
    );
    const jx = await req("POST", "/calls/" + j1id + "/cancel", { key: "test-key-j3" });
    check(
      "j: moto que nao aceitou nao cancela chamado pendente -> 403 not_call_party",
      jx.status === 403 && jx.data && jx.data.error === "not_call_party",
      "status=" + jx.status + " " + JSON.stringify(jx.data)
    );
    const jx2 = await req("POST", "/calls/" + j2id + "/cancel", { key: "test-key-j3" });
    check(
      "j: terceiro nao cancela chamado aceito por outro -> 403 not_call_party",
      jx2.status === 403 && jx2.data && jx2.data.error === "not_call_party",
      "status=" + jx2.status + " " + JSON.stringify(jx2.data)
    );
    const jdone = await req("POST", "/calls/" + j2id + "/complete", { key: "test-key-j1" });
    check("j: J1 conclui o chamado 2 -> 200", jdone.status === 200 && jdone.data.call.status === "completed", JSON.stringify(jdone.data));
    const jcx = await req("POST", "/calls/" + j2id + "/cancel", { key: "test-key-j1" });
    check(
      "j: cancelar chamado ja concluido -> 200 already, sem erro",
      jcx.status === 200 && jcx.data.already === true && jcx.data.call.status === "completed",
      JSON.stringify(jcx.data)
    );

    // touch no chamado avulso (a) — precisa de parte do chamado; o
    // chamador nao tem conta, entao o touch com chave desconhecida
    // deve dar 403 (regra de parte do chamado, sem mudar nada).
    const t = await req("POST", "/calls/" + plainId + "/touch", { key: "test-key-1" });
    check("touch com chave que nao e parte do chamado -> 403 not_call_party", t.status === 403 && t.data && t.data.error === "not_call_party", "status=" + t.status + " " + JSON.stringify(t.data));

    // (k) quem chamou com ID DE CONTA (v1.8.3): o app cria o chamado
    // com callerPhone=myKey(), que e o id da conta ("acc_..."), nao o
    // telefone. Antes, quem chamou levava 403 not_call_party no chat,
    // no cancelamento e no touch — o audio so ficava para quem gravou
    // e o cliente nao conseguia nem cancelar o proprio chamado.
    console.log("== (k) quem chamou com id de conta: chat, touch e cancelar ==");
    const k1 = await req("POST", "/calls", baseCall({ callerPhone: "acc_test_caller_k1" }));
    const k1id = k1.data.call.id;
    const ka1 = await req("POST", "/calls/" + k1id + "/accept", { key: "test-key-k1", name: "Moto K1" });
    check("k: moto K1 aceita o chamado da conta -> 200", ka1.status === 200 && ka1.data.call.status === "accepted", JSON.stringify(ka1.data));
    const kAudio = "data:audio/webm;codecs=opus;base64," + "BBBB".repeat(1000);
    const km1 = await req("POST", "/calls/" + k1id + "/messages", { from: "caller", key: "acc_test_caller_k1", audio: kAudio, durationSec: 9 });
    check("k: quem chamou ENVIA audio com o id da conta -> 201", km1.status === 201, "status=" + km1.status + " " + JSON.stringify(km1.data));
    const kd1 = await req("POST", "/calls/" + k1id + "/messages", { from: "driver", key: "test-key-k1", audio: kAudio, durationSec: 9 });
    check("k: mototaxi envia audio -> 201", kd1.status === 201, "status=" + kd1.status + " " + JSON.stringify(kd1.data));
    const kg1 = await req("GET", "/calls/" + k1id + "/messages?for=caller&key=acc_test_caller_k1&since=0");
    const kGotDriver = (kg1.data.messages || []).find((m) => m.from === "driver");
    const kGotCaller = (kg1.data.messages || []).find((m) => m.from === "caller");
    check(
      "k: quem chamou RECEBE o audio do mototaxi e o proprio no polling",
      kg1.status === 200 && !!kGotDriver && !!kGotCaller,
      JSON.stringify(kg1.data)
    );
    const kg2 = await req("GET", "/calls/" + k1id + "/messages?for=driver&key=test-key-k1&since=0");
    const kGotCaller2 = (kg2.data.messages || []).find((m) => m.from === "caller");
    check(
      "k: mototaxi RECEBE o audio de quem chamou no polling",
      kg2.status === 200 && !!kGotCaller2,
      JSON.stringify(kg2.data)
    );
    const kt1 = await req("POST", "/calls/" + k1id + "/touch", { key: "acc_test_caller_k1" });
    check("k: quem chamou da touch com o id da conta -> 200", kt1.status === 200, "status=" + kt1.status + " " + JSON.stringify(kt1.data));
    const kx = await req("POST", "/calls/" + k1id + "/messages", { from: "caller", key: "test-key-terceiro", audio: kAudio, durationSec: 9 });
    check(
      "k: terceiro nao envia audio no chamado dos outros -> 403 not_call_party",
      kx.status === 403 && kx.data && kx.data.error === "not_call_party",
      "status=" + kx.status + " " + JSON.stringify(kx.data)
    );
    const kx2 = await req("GET", "/calls/" + k1id + "/messages?for=caller&key=test-key-terceiro&since=0");
    check(
      "k: terceiro nao le o chat dos outros -> 403 not_call_party",
      kx2.status === 403 && kx2.data && kx2.data.error === "not_call_party",
      "status=" + kx2.status + " " + JSON.stringify(kx2.data)
    );
    const k2 = await req("POST", "/calls", baseCall({ callerPhone: "acc_test_caller_k1" }));
    const k2id = k2.data.call.id;
    const kc2 = await req("POST", "/calls/" + k2id + "/cancel", { key: "acc_test_caller_k1" });
    check(
      "k: quem chamou CANCELA o proprio chamado pendente com o id da conta -> 200 cancelled",
      kc2.status === 200 && kc2.data.call.status === "cancelled",
      JSON.stringify(kc2.data)
    );
    const k3 = await req("POST", "/calls", baseCall({ callerPhone: "81999990000" }));
    const k3id = k3.data.call.id;
    const kx3 = await req("POST", "/calls/" + k3id + "/cancel", { key: "test-key-terceiro" });
    check(
      "k: chamado antigo com telefone: terceiro sem conta nao cancela -> 403 not_call_party",
      kx3.status === 403 && kx3.data && kx3.data.error === "not_call_party",
      "status=" + kx3.status + " " + JSON.stringify(kx3.data)
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill("SIGKILL");
  }

  console.log("\n" + passed + " passaram, " + failed + " falharam.");
  if (failures.length) {
    console.log("Falhas:");
    for (const f of failures) console.log(" - " + f);
  }
  process.exitCode = failed ? 1 : 0;
}

run().catch((err) => {
  console.error("Erro no teste:", err);
  process.exitCode = 1;
});
