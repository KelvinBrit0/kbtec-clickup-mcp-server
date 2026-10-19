import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuardedFetch, KB_WORKSPACE_ID, WorkspaceGuardError } from "../kb/workspace-guard";

/**
 * A trava é testada sobre um fetch falso: cada rota devolve um JSON fixo e toda chamada que
 * chega "à rede" fica registrada. Assim dá para provar não só que a trava nega, mas que a
 * chamada negada nunca saiu.
 */
const FERREIRA = "90132065132";
const API = "https://api.clickup.com/api/v2";
const AUTH = { headers: { Authorization: "pk_test" } };

function fakeApi(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const base = (async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname.replace("/api/v2", "").replace("/api/v3", "v3")}${url.search}`;
    calls.push(key);
    const body = routes[key] ?? routes[key.split("?")[0]];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: createGuardedFetch(base), calls };
}

const KB_SPACES = {
  [`GET /team/${KB_WORKSPACE_ID}/space?archived=false`]: { spaces: [{ id: "sKB" }] },
  [`GET /team/${KB_WORKSPACE_ID}/space?archived=true`]: { spaces: [{ id: "sKBold" }] },
};

const BASE_ROUTES = {
  ...KB_SPACES,
  "GET /task/kb1": { id: "kb1", team_id: KB_WORKSPACE_ID },
  "GET /task/kb2": { id: "kb2", team_id: KB_WORKSPACE_ID },
  "GET /task/fer1": { id: "fer1", team_id: FERREIRA },
  "PUT /task/kb1": { id: "kb1" },
  "PUT /task/fer1": { id: "fer1" },
  "GET /list/lkb": { id: "lkb", space: { id: "sKB" } },
  "GET /list/lfer": { id: "lfer", space: { id: "sFER" } },
  "POST /list/lkb/task": { id: "novo" },
  "POST /list/lfer/task": { id: "novo" },
  "GET /task/kb1/comment": { comments: [{ id: "c1" }] },
  "POST /task/kb1/comment": { id: "c2" },
  "PUT /comment/c1": {},
  "PUT /comment/c2": {},
  "PUT /comment/c9": {},
  "GET /team": { teams: [{ id: KB_WORKSPACE_ID, name: "KB" }, { id: FERREIRA, name: "Ferreira" }] },
  [`GET /team/${FERREIRA}/time_entries`]: { data: [] },
  [`GET /team/${KB_WORKSPACE_ID}/time_entries`]: { data: [] },
  "POST /task/kb1/dependency": {},
  "POST /task/kb1/link/fer1": {},
  "POST /task/kb1/link/kb2": {},
};

async function rejectsGuard(p: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(p, (err: unknown) => err instanceof WorkspaceGuardError && pattern.test((err as Error).message));
}

test("lê e escreve tarefa da KB", async () => {
  const api = fakeApi(BASE_ROUTES);
  const res = await api.fetch(`${API}/task/kb1`, { ...AUTH, method: "PUT", body: "{}" });
  assert.equal(res.status, 200);
  assert.deepEqual(api.calls, ["GET /task/kb1", "PUT /task/kb1"]);
});

test("nega escrever tarefa do Ferreira, e o PUT nunca sai", async () => {
  const api = fakeApi(BASE_ROUTES);
  await rejectsGuard(api.fetch(`${API}/task/fer1`, { ...AUTH, method: "PUT", body: "{}" }), /fer1 não é do workspace da KB/);
  assert.deepEqual(api.calls, ["GET /task/fer1"]);
});

test("nega tarefa que não se consegue confirmar (404, sem acesso)", async () => {
  const api = fakeApi(BASE_ROUTES);
  await rejectsGuard(api.fetch(`${API}/task/sumida`, AUTH), /sumida/);
});

test("nega workspace do Ferreira no caminho sem consultar nada", async () => {
  const api = fakeApi(BASE_ROUTES);
  await rejectsGuard(api.fetch(`${API}/team/${FERREIRA}/time_entries`, AUTH), new RegExp(`${FERREIRA} não é o da KB`));
  assert.deepEqual(api.calls, []);
  const ok = await api.fetch(`${API}/team/${KB_WORKSPACE_ID}/time_entries`, AUTH);
  assert.equal(ok.status, 200);
});

test("GET /team devolve só o workspace da KB", async () => {
  const api = fakeApi(BASE_ROUTES);
  const body = await (await api.fetch(`${API}/team`, AUTH)).json();
  assert.deepEqual(body.teams.map((t: any) => t.id), [KB_WORKSPACE_ID]);
});

test("rota v3 só no workspace da KB", async () => {
  const api = fakeApi({ [`GET v3/workspaces/${KB_WORKSPACE_ID}/docs`]: { docs: [] } });
  await rejectsGuard(api.fetch(`https://api.clickup.com/api/v3/workspaces/${FERREIRA}/docs`, AUTH), /rota v3/);
  const ok = await api.fetch(`https://api.clickup.com/api/v3/workspaces/${KB_WORKSPACE_ID}/docs`, AUTH);
  assert.equal(ok.status, 200);
});

test("criar tarefa: lista da KB passa, lista de outro espaço é negada", async () => {
  const api = fakeApi(BASE_ROUTES);
  assert.equal((await api.fetch(`${API}/list/lkb/task`, { ...AUTH, method: "POST" })).status, 200);
  await rejectsGuard(api.fetch(`${API}/list/lfer/task`, { ...AUTH, method: "POST" }), /lista lfer/);
  assert.ok(!api.calls.includes("POST /list/lfer/task"));
});

test("espaço arquivado da KB continua liberado; espaço alheio não", async () => {
  const api = fakeApi({ ...BASE_ROUTES, "GET /space/sKBold": { id: "sKBold" }, "GET /space/sFER": { id: "sFER" } });
  assert.equal((await api.fetch(`${API}/space/sKBold`, AUTH)).status, 200);
  await rejectsGuard(api.fetch(`${API}/space/sFER`, AUTH), /espaço sFER/);
});

test("comentário só é editável depois de lido (ou criado) numa tarefa da KB", async () => {
  const api = fakeApi(BASE_ROUTES);
  await rejectsGuard(api.fetch(`${API}/comment/c1`, { ...AUTH, method: "PUT" }), /comentário c1/);
  await api.fetch(`${API}/task/kb1/comment`, AUTH);
  assert.equal((await api.fetch(`${API}/comment/c1`, { ...AUTH, method: "PUT" })).status, 200);
  await api.fetch(`${API}/task/kb1/comment`, { ...AUTH, method: "POST" });
  assert.equal((await api.fetch(`${API}/comment/c2`, { ...AUTH, method: "PUT" })).status, 200);
  await rejectsGuard(api.fetch(`${API}/comment/c9`, { ...AUTH, method: "PUT" }), /comentário c9/);
});

test("dependência e vínculo com tarefa do Ferreira são negados", async () => {
  const api = fakeApi(BASE_ROUTES);
  await rejectsGuard(
    api.fetch(`${API}/task/kb1/dependency?depends_on=fer1`, { ...AUTH, method: "POST" }),
    /fer1 \(vínculo/
  );
  await rejectsGuard(api.fetch(`${API}/task/kb1/link/fer1`, { ...AUTH, method: "POST" }), /fer1 \(vínculo/);
  assert.equal((await api.fetch(`${API}/task/kb1/link/kb2`, { ...AUTH, method: "POST" })).status, 200);
});

test("ID personalizado só com team_id da KB", async () => {
  const api = fakeApi(BASE_ROUTES);
  await rejectsGuard(api.fetch(`${API}/task/ABC-1?custom_task_ids=true&team_id=${FERREIRA}`, AUTH), /ABC-1/);
  assert.deepEqual(api.calls, []);
});

test("rota desconhecida é negada (na dúvida, nega)", async () => {
  const api = fakeApi(BASE_ROUTES);
  await rejectsGuard(api.fetch(`${API}/goal/g1`, AUTH), /rota \/goal/);
  await rejectsGuard(api.fetch(`${API}/team`, { ...AUTH, method: "POST" }), /escrita em \/team/);
  await rejectsGuard(api.fetch(`https://api.clickup.com/outra`, AUTH), /rota desconhecida/);
});

test("o token nunca sai para outro host; sem token, outro host passa", async () => {
  const api = fakeApi({ "GET /img.png": {} });
  await rejectsGuard(api.fetch("https://exemplo.com/img.png", AUTH), /não sai para exemplo.com/);
  await rejectsGuard(
    api.fetch("https://exemplo.com/img.png", { headers: { authorization: "pk_test" } }),
    /não sai para/
  );
  assert.equal((await api.fetch("https://exemplo.com/img.png")).status, 200);
});

test("API do ClickUp só por https e com token", async () => {
  const api = fakeApi(BASE_ROUTES);
  await rejectsGuard(api.fetch(`http://api.clickup.com/api/v2/task/kb1`, AUTH), /https/);
  await rejectsGuard(api.fetch(`${API}/task/kb1`), /sem token/);
});

test("a posse fica guardada: a segunda chamada não consulta de novo", async () => {
  const api = fakeApi(BASE_ROUTES);
  await api.fetch(`${API}/task/kb1`, AUTH);
  await api.fetch(`${API}/task/kb1`, { ...AUTH, method: "PUT" });
  assert.equal(api.calls.filter((c) => c === "GET /task/kb1").length, 2); // 1 consulta + 1 leitura
});

test("mover tarefa (v3): tarefa e lista de destino têm de ser da KB", async () => {
  const api = fakeApi({
    ...BASE_ROUTES,
    [`PUT v3/workspaces/${KB_WORKSPACE_ID}/tasks/kb1/home_list/lkb`]: {},
  });
  const v3 = `https://api.clickup.com/api/v3/workspaces/${KB_WORKSPACE_ID}`;
  assert.equal((await api.fetch(`${v3}/tasks/kb1/home_list/lkb`, { ...AUTH, method: "PUT" })).status, 200);
  await rejectsGuard(api.fetch(`${v3}/tasks/fer1/home_list/lkb`, { ...AUTH, method: "PUT" }), /tarefa fer1/);
  await rejectsGuard(api.fetch(`${v3}/tasks/kb1/home_list/lfer`, { ...AUTH, method: "PUT" }), /lista lfer/);
  assert.ok(!api.calls.some((c) => c.startsWith("PUT v3") && c.includes("fer")));
});

// --- Achados do revisor (18/10/2026): IDs citados no corpo e na query, redirecionamento, falha de rede ---

const post = (body: unknown) => ({ ...AUTH, method: "POST", body: JSON.stringify(body) });

test("corpo: dependência, tarefa-mãe e tid de fora são negados antes de sair", async () => {
  const api = fakeApi(BASE_ROUTES);
  await rejectsGuard(api.fetch(`${API}/task/kb1/dependency`, post({ depends_on: "fer1" })), /fer1 \(depends_on\)/);
  await rejectsGuard(api.fetch(`${API}/list/lkb/task`, post({ name: "x", parent: "fer1" })), /fer1 \(tarefa-mãe\)/);
  await rejectsGuard(
    api.fetch(`${API}/team/${KB_WORKSPACE_ID}/time_entries/start`, post({ tid: "fer1" })),
    /fer1 \(tid\)/
  );
  assert.ok(!api.calls.some((c) => c.startsWith("POST")));
  assert.equal((await api.fetch(`${API}/task/kb1/dependency`, post({ depends_on: "kb2" }))).status, 200);
});

test("query: time_entries?task_id= de fora é negado", async () => {
  const api = fakeApi(BASE_ROUTES);
  await rejectsGuard(api.fetch(`${API}/team/${KB_WORKSPACE_ID}/time_entries?task_id=fer1`, AUTH), /fer1 \(task_id\)/);
});

test("documento (v3): pai em espaço ou lista de fora é negado", async () => {
  const api = fakeApi({ ...BASE_ROUTES, [`POST v3/workspaces/${KB_WORKSPACE_ID}/docs`]: {} });
  const docs = `https://api.clickup.com/api/v3/workspaces/${KB_WORKSPACE_ID}/docs`;
  await rejectsGuard(api.fetch(docs, post({ name: "d", parent: { id: "sFER", type: 4 } })), /espaço sFER/);
  await rejectsGuard(api.fetch(docs, post({ name: "d", parent: { id: "lfer", type: 6 } })), /lista lfer/);
  await rejectsGuard(api.fetch(docs, post({ name: "d", parent: { id: "x", type: 99 } })), /pai de documento/);
  assert.equal((await api.fetch(docs, post({ name: "d", parent: { id: "sKB", type: 4 } }))).status, 200);
});

test("campo do tipo tarefas: valor de fora é negado; outros tipos passam", async () => {
  const api = fakeApi({
    ...BASE_ROUTES,
    "GET /task/kb1": { id: "kb1", team_id: KB_WORKSPACE_ID, custom_fields: [{ id: "fT", type: "tasks" }, { id: "fD", type: "drop_down" }] },
    "POST /task/kb1/field/fT": {},
    "POST /task/kb1/field/fD": {},
    "GET /list/lkb/field": { fields: [{ id: "fT", type: "tasks" }, { id: "fD", type: "drop_down" }] },
  });
  await rejectsGuard(api.fetch(`${API}/task/kb1/field/fT`, post({ value: { add: ["fer1"], rem: [] } })), /campo de tarefas/);
  assert.equal((await api.fetch(`${API}/task/kb1/field/fT`, post({ value: { add: ["kb2"] } }))).status, 200);
  assert.equal((await api.fetch(`${API}/task/kb1/field/fD`, post({ value: "uuid-opcao" }))).status, 200);
  await rejectsGuard(
    api.fetch(`${API}/list/lkb/task`, post({ name: "x", custom_fields: [{ id: "fT", value: ["fer1"] }] })),
    /campo de tarefas/
  );
  assert.equal((await api.fetch(`${API}/list/lkb/task`, post({ name: "x", custom_fields: [{ id: "fD", value: "op" }] }))).status, 200);
});

test("tarefa citada em rota de lista (/list/{id}/task/{tarefa}) é conferida", async () => {
  const api = fakeApi({ ...BASE_ROUTES, "POST /list/lkb/task/fer1": {} });
  await rejectsGuard(api.fetch(`${API}/list/lkb/task/fer1`, { ...AUTH, method: "POST" }), /fer1 \(na lista\)/);
});

test("redirecionamento da API não é seguido", async () => {
  const base = (async () => new Response(null, { status: 302, headers: { location: "https://outro.com/" } })) as typeof fetch;
  const guarded = createGuardedFetch(base);
  await rejectsGuard(guarded(`${API}/team/${KB_WORKSPACE_ID}/space`, AUTH), /redirecionamento/);
});

test("falha de rede ao carregar espaços não trava as conferências seguintes", async () => {
  let fail = true;
  const base = (async (input: any) => {
    const url = String(input);
    if (fail && url.includes("/space?archived")) throw new Error("rede caiu");
    if (url.includes("archived=false")) return Response.json({ spaces: [{ id: "sKB" }] });
    if (url.includes("archived=true")) return Response.json({ spaces: [] });
    return Response.json({ id: "sKB" });
  }) as typeof fetch;
  const guarded = createGuardedFetch(base);
  await rejectsGuard(guarded(`${API}/space/sKB`, AUTH), /espaço sKB/);
  fail = false;
  assert.equal((await guarded(`${API}/space/sKB`, AUTH)).status, 200);
});

// --- Rotas novas de 19/10/2026: lista, pasta, checklist e modelo de tarefa ---

test("criar lista: no espaço ou pasta da KB passa; em espaço ou pasta de fora é negado sem sair", async () => {
  const api = fakeApi({
    ...BASE_ROUTES,
    "GET /folder/fkb": { id: "fkb", space: { id: "sKB" } },
    "GET /folder/ffer": { id: "ffer", space: { id: "sFER" } },
    "POST /space/sKB/list": { id: "novaLista" },
    "POST /space/sFER/list": { id: "x" },
    "POST /folder/fkb/list": { id: "novaLista2" },
    "POST /folder/ffer/list": { id: "x" },
  });
  assert.equal((await api.fetch(`${API}/space/sKB/list`, post({ name: "Clientes" }))).status, 200);
  assert.equal((await api.fetch(`${API}/folder/fkb/list`, post({ name: "Clientes" }))).status, 200);
  await rejectsGuard(api.fetch(`${API}/space/sFER/list`, post({ name: "Clientes" })), /espaço sFER/);
  await rejectsGuard(api.fetch(`${API}/folder/ffer/list`, post({ name: "Clientes" })), /pasta ffer/);
  assert.ok(!api.calls.some((c) => c.startsWith("POST") && c.includes("fer")));
});

test("criar pasta: espaço de fora negado; subpasta com pai de fora negada", async () => {
  const api = fakeApi({
    ...BASE_ROUTES,
    "GET /folder/ffer": { id: "ffer", space: { id: "sFER" } },
    "POST /space/sKB/folder": { id: "novaPasta" },
  });
  assert.equal((await api.fetch(`${API}/space/sKB/folder`, post({ name: "Clientes" }))).status, 200);
  await rejectsGuard(api.fetch(`${API}/space/sFER/folder`, post({ name: "x" })), /espaço sFER/);
  await rejectsGuard(
    api.fetch(`${API}/space/sKB/folder`, post({ name: "x", parent_folder_id: "ffer" })),
    /pasta ffer \(citada\)/
  );
});

test("checklist: item só em checklist criada ou lida numa tarefa da KB", async () => {
  const api = fakeApi({
    ...BASE_ROUTES,
    "GET /task/kb1": { id: "kb1", team_id: KB_WORKSPACE_ID, checklists: [{ id: "chkLido" }] },
    "POST /task/kb1/checklist": { checklist: { id: "chkNovo" } },
    "POST /checklist/chkNovo/checklist_item": {},
    "POST /checklist/chkLido/checklist_item": {},
    "POST /checklist/chkAlheio/checklist_item": {},
  });
  await rejectsGuard(api.fetch(`${API}/checklist/chkNovo/checklist_item`, post({ name: "i" })), /checklist chkNovo/);
  await api.fetch(`${API}/task/kb1/checklist`, post({ name: "Entrada" }));
  assert.equal((await api.fetch(`${API}/checklist/chkNovo/checklist_item`, post({ name: "i" }))).status, 200);
  assert.equal((await api.fetch(`${API}/checklist/chkLido/checklist_item`, post({ name: "i" }))).status, 200);
  await rejectsGuard(api.fetch(`${API}/checklist/chkAlheio/checklist_item`, post({ name: "i" })), /checklist chkAlheio/);
  await rejectsGuard(api.fetch(`${API}/task/fer1/checklist`, post({ name: "x" })), /fer1/);
});

test("modelo de tarefa: só modelo do workspace da KB, só em lista da KB", async () => {
  const api = fakeApi({
    ...BASE_ROUTES,
    [`GET /team/${KB_WORKSPACE_ID}/taskTemplate?page=0`]: { templates: [{ id: "tplKB", name: "Entrada de cliente" }] },
    [`GET /team/${KB_WORKSPACE_ID}/taskTemplate?page=1`]: { templates: [] },
    "POST /list/lkb/taskTemplate/tplKB": { id: "nova" },
    "POST /list/lkb/taskTemplate/tplFER": { id: "x" },
    "POST /list/lfer/taskTemplate/tplKB": { id: "x" },
  });
  assert.equal((await api.fetch(`${API}/list/lkb/taskTemplate/tplKB`, post({ name: "David" }))).status, 200);
  await rejectsGuard(api.fetch(`${API}/list/lkb/taskTemplate/tplFER`, post({ name: "x" })), /modelo de tarefa tplFER/);
  await rejectsGuard(api.fetch(`${API}/list/lfer/taskTemplate/tplKB`, post({ name: "x" })), /lista lfer/);
  assert.ok(!api.calls.some((c) => c.startsWith("POST") && (c.includes("tplFER") || c.includes("lfer"))));
});
