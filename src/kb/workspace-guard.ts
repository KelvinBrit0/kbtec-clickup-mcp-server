/**
 * Trava do workspace da KB (camada da KB Tecnologia sobre o hauptsacheNet/clickup-mcp).
 *
 * Por que existe: na API REST do ClickUp quase toda rota é pelo ID do objeto (/task/{id},
 * /list/{id}, /comment/{id}), sem o workspace no caminho. O token responde por todos os
 * workspaces que o usuário dele enxerga. Então "travar num workspace" só funciona se alguém
 * perguntar, antes de cada chamada, de quem é aquele objeto — e este módulo é esse alguém.
 *
 * Como funciona: substitui o `fetch` global do processo. Toda chamada do servidor (as do
 * original e as que ele ganhar no futuro) passa por aqui, sem precisar editar cada uma.
 * - Rota para api.clickup.com: só passa se o objeto for do workspace da KB. Rota que este
 *   módulo não conhece é recusada (na dúvida, nega).
 * - Rota para outro host: passa, mas nunca levando o cabeçalho Authorization (o token).
 * O workspace fica escrito aqui, no código, e não em configuração.
 */

export const KB_WORKSPACE_ID = "90171602543";

const API_HOST = "api.clickup.com";
const API = `https://${API_HOST}/api/v2`;
const GUARD_MARK = Symbol.for("kbtec.workspaceGuard");

export class WorkspaceGuardError extends Error {
  constructor(reason: string) {
    super(`Bloqueado pela trava da KB (só o workspace ${KB_WORKSPACE_ID}): ${reason}`);
    this.name = "WorkspaceGuardError";
  }
}

type FetchFn = typeof fetch;

function requestUrl(input: Parameters<FetchFn>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL((input as Request).url);
}

function requestMethod(input: Parameters<FetchFn>[0], init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function authorizationOf(input: Parameters<FetchFn>[0], init?: RequestInit): string | null {
  const fromInit = init?.headers ? new Headers(init.headers).get("authorization") : null;
  if (fromInit) return fromInit;
  return input instanceof Request ? input.headers.get("authorization") : null;
}

export function createGuardedFetch(baseFetch: FetchFn): FetchFn {
  // Respostas de posse ficam guardadas pelo tempo do processo: um ID não muda de workspace
  // com frequência, e cada consulta gasta uma chamada da cota da API.
  const ownerCache = new Map<string, Promise<boolean>>();
  const knownComments = new Set<string>();
  // A tarefa lida na conferência fica guardada: é dela que sai o tipo de cada campo
  // personalizado (um campo "tasks" cita outras tarefas no corpo).
  const taskData = new Map<string, any>();
  let kbSpaces: Promise<Set<string>> | null = null;

  async function getJson(path: string, auth: string): Promise<any | null> {
    const res = await baseFetch(`${API}${path}`, { headers: { Authorization: auth }, redirect: "error" });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  async function loadKbSpaces(auth: string): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const archived of ["false", "true"]) {
      const data = await getJson(`/team/${KB_WORKSPACE_ID}/space?archived=${archived}`, auth);
      for (const s of data?.spaces ?? []) ids.add(String(s.id));
    }
    return ids;
  }

  function spaces(auth: string, reload = false): Promise<Set<string>> {
    if (!kbSpaces || reload) {
      const loading = loadKbSpaces(auth);
      kbSpaces = loading;
      // Falha de rede não fica guardada: senão toda conferência de espaço falharia até reiniciar.
      loading.catch(() => { if (kbSpaces === loading) kbSpaces = null; });
    }
    return kbSpaces;
  }

  async function spaceIsKb(spaceId: string, auth: string): Promise<boolean> {
    try {
      if ((await spaces(auth)).has(spaceId)) return true;
      // Espaço criado depois do cache: recarrega uma vez antes de negar.
      return (await spaces(auth, true)).has(spaceId);
    } catch {
      return false; // sem conseguir confirmar, nega
    }
  }

  function cached(key: string, check: () => Promise<boolean>): Promise<boolean> {
    let hit = ownerCache.get(key);
    if (!hit) {
      hit = check().catch(() => false);
      ownerCache.set(key, hit);
      // Falha (rede, 404) não fica guardada: a próxima tentativa consulta de novo.
      hit.then((ok) => { if (!ok) ownerCache.delete(key); });
    }
    return hit;
  }

  function taskIsKb(taskId: string, params: URLSearchParams, auth: string): Promise<boolean> {
    const custom = params.get("custom_task_ids") === "true";
    if (custom && params.get("team_id") !== KB_WORKSPACE_ID) return Promise.resolve(false);
    const query = custom ? `?custom_task_ids=true&team_id=${KB_WORKSPACE_ID}` : "";
    return cached(`task:${taskId}${query}`, async () => {
      const task = await getJson(`/task/${encodeURIComponent(taskId)}${query}`, auth);
      const ok = String(task?.team_id ?? "") === KB_WORKSPACE_ID;
      if (ok) taskData.set(taskId, task);
      return ok;
    });
  }

  function containerIsKb(kind: "list" | "folder", id: string, auth: string): Promise<boolean> {
    return cached(`${kind}:${id}`, async () => {
      const data = await getJson(`/${kind}/${encodeURIComponent(id)}`, auth);
      const spaceId = data?.space?.id;
      return spaceId != null && spaceIsKb(String(spaceId), auth);
    });
  }

  async function assertTask(id: string, auth: string, what = "citada") {
    if (!(await taskIsKb(id, new URLSearchParams(), auth))) {
      throw new WorkspaceGuardError(`a tarefa ${id} (${what}) não é do workspace da KB`);
    }
  }

  async function assertContainer(kind: "list" | "folder" | "space", id: string, auth: string) {
    const ok = kind === "space" ? await spaceIsKb(id, auth) : await containerIsKb(kind, id, auth);
    if (!ok) throw new WorkspaceGuardError(`${{ list: "a lista", folder: "a pasta", space: "o espaço" }[kind]} ${id} (citada) não é do workspace da KB`);
  }

  /**
   * IDs citados fora do caminho: na query (ex.: time_entries?task_id=) e no corpo JSON
   * (tarefa-mãe, dependência, tid do cronômetro, pai de documento, campo do tipo tarefas).
   */
  async function assertReferences(seg: string[], url: URL, body: unknown, auth: string): Promise<void> {
    const refs: Record<string, "task" | "list" | "folder" | "space"> = {
      task_id: "task", tid: "task", depends_on: "task", dependency_of: "task", links_to: "task",
      list_id: "list", folder_id: "folder", space_id: "space",
    };
    for (const [key, kind] of Object.entries(refs)) {
      for (const value of url.searchParams.getAll(key)) {
        if (kind === "task") await assertTask(value, auth, key);
        else await assertContainer(kind, value, auth);
      }
    }
    if (!body || typeof body !== "object") return;
    const b = body as Record<string, any>;
    for (const [key, kind] of Object.entries(refs)) {
      const value = b[key];
      if (typeof value !== "string" && typeof value !== "number") continue;
      if (kind === "task") await assertTask(String(value), auth, key);
      else await assertContainer(kind, String(value), auth);
    }
    // parent: em tarefa é o ID da tarefa-mãe; em documento (v3) é {id, type}.
    if (typeof b.parent === "string" && b.parent) await assertTask(b.parent, auth, "tarefa-mãe");
    if (b.parent && typeof b.parent === "object") {
      const kinds: Record<number, "space" | "folder" | "list"> = { 4: "space", 5: "folder", 6: "list" };
      const pid = String(b.parent.id ?? "");
      const kind = kinds[Number(b.parent.type)];
      if (kind) await assertContainer(kind, pid, auth);
      else if (pid !== KB_WORKSPACE_ID) {
        throw new WorkspaceGuardError(`pai de documento ${pid} (tipo ${b.parent.type}) não liberado`);
      }
    }
    // Criar tarefa com campos: os do tipo "tasks" citam outras tarefas (tipos vêm da lista).
    if (seg[1] === "v2" && seg[2] === "list" && seg[4] === "task" && !seg[5] && Array.isArray(b.custom_fields)) {
      const fields = (await getJson(`/list/${encodeURIComponent(seg[3])}/field`, auth))?.fields ?? [];
      for (const cf of b.custom_fields) {
        const field = fields.find((f: any) => String(f.id) === String(cf?.id));
        if (!field) throw new WorkspaceGuardError(`campo ${cf?.id} desconhecido na lista ${seg[3]}`);
        if (field.type !== "tasks") continue;
        const v = cf.value;
        const ids = Array.isArray(v) ? v : v && typeof v === "object" ? [...(v.add ?? []), ...(v.rem ?? [])] : v != null ? [v] : [];
        for (const id of ids) await assertTask(String(id), auth, "campo de tarefas");
      }
    }
    // Campo personalizado do tipo "tasks": o valor cita outras tarefas.
    if (seg[1] === "v2" && seg[2] === "task" && seg[4] === "field" && seg[5]) {
      const field = (taskData.get(seg[3])?.custom_fields ?? []).find((f: any) => String(f.id) === seg[5]);
      if (!field) throw new WorkspaceGuardError(`campo ${seg[5]} desconhecido na tarefa ${seg[3]}`);
      if (field.type === "tasks") {
        const v = b.value;
        const ids = Array.isArray(v) ? v : v && typeof v === "object" ? [...(v.add ?? []), ...(v.rem ?? [])] : v != null ? [v] : [];
        for (const id of ids) await assertTask(String(id), auth, "campo de tarefas");
      }
    }
  }

  async function assertAllowed(url: URL, method: string, auth: string): Promise<void> {
    const seg = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (seg[0] !== "api") throw new WorkspaceGuardError(`rota desconhecida ${url.pathname}`);

    if (seg[1] === "v3") {
      if (seg[2] !== "workspaces" || seg[3] !== KB_WORKSPACE_ID) {
        throw new WorkspaceGuardError(`rota v3 fora do workspace da KB (${url.pathname})`);
      }
      // O workspace no caminho não basta quando a rota cita uma tarefa ou lista pelo ID:
      // confere cada uma (ex.: /tasks/{id}/home_list/{lista} ao mover).
      if (seg[4] === "tasks" && seg[5] && !(await taskIsKb(seg[5], new URLSearchParams(), auth))) {
        throw new WorkspaceGuardError(`a tarefa ${seg[5]} não é do workspace da KB`);
      }
      if (seg[6] === "home_list" && seg[7] && !(await containerIsKb("list", seg[7], auth))) {
        throw new WorkspaceGuardError(`a lista ${seg[7]} não é do workspace da KB`);
      }
      return;
    }
    if (seg[1] !== "v2") throw new WorkspaceGuardError(`versão de API desconhecida (${url.pathname})`);

    const [, , resource, id, sub, subId] = seg;
    const deny = (why: string) => { throw new WorkspaceGuardError(why); };

    switch (resource) {
      case "user":
        if (id === undefined && method === "GET") return;
        return deny(`rota /user/${id ?? ""} não liberada`);

      case "team":
        if (id === undefined) {
          if (method === "GET") return; // a resposta é filtrada para mostrar só a KB
          return deny("escrita em /team não liberada");
        }
        if (id === KB_WORKSPACE_ID) return;
        return deny(`workspace ${id} não é o da KB`);

      case "task": {
        if (!id) return deny("rota /task sem ID");
        if (!(await taskIsKb(id, url.searchParams, auth))) deny(`a tarefa ${id} não é do workspace da KB`);
        // Dependência e vínculo tocam uma segunda tarefa: ela também tem de ser da KB.
        const others = [url.searchParams.get("depends_on"), url.searchParams.get("dependency_of")];
        if (sub === "link" && subId) others.push(subId);
        for (const other of others) {
          if (other && !(await taskIsKb(other, new URLSearchParams(), auth))) {
            deny(`a tarefa ${other} (vínculo/dependência) não é do workspace da KB`);
          }
        }
        return;
      }

      case "list":
      case "folder":
        if (!id) return deny(`rota /${resource} sem ID`);
        // /list/{id}/task/{tarefa} (tarefa em várias listas) cita uma segunda tarefa.
        if (sub === "task" && subId) await assertTask(subId, auth, "na lista");
        if (await containerIsKb(resource, id, auth)) return;
        return deny(`${resource === "list" ? "a lista" : "a pasta"} ${id} não é do workspace da KB`);

      case "space":
        if (!id) return deny("rota /space sem ID");
        if (await spaceIsKb(id, auth)) return;
        return deny(`o espaço ${id} não é do workspace da KB`);

      case "comment":
        // Comentário não tem rota de leitura própria que diga o workspace. Só passa o
        // comentário que este processo já viu sair de uma tarefa ou lista da KB.
        if (id && knownComments.has(id)) return;
        return deny(`o comentário ${id ?? ""} não foi lido de uma tarefa da KB nesta sessão`);

      default:
        return deny(`rota /${resource ?? ""} não liberada`);
    }
  }

  /** Anota os comentários que vieram de objetos já conferidos, para liberar editar/responder. */
  async function rememberComments(url: URL, res: Response): Promise<void> {
    const seg = url.pathname.split("/").filter(Boolean);
    const isCommentList =
      (["task", "list"].includes(seg[2]) && seg[4] === "comment") || (seg[2] === "comment" && seg[4] === "reply");
    if (!isCommentList || !res.ok) return;
    const body = await res.clone().json().catch(() => null);
    for (const c of body?.comments ?? []) if (c?.id != null) knownComments.add(String(c.id));
    if (body?.id != null) knownComments.add(String(body.id));
  }

  async function onlyKbTeams(res: Response): Promise<Response> {
    if (!res.ok) return res;
    const body = await res.clone().json().catch(() => null);
    if (!Array.isArray(body?.teams)) return res;
    const teams = body.teams.filter((t: any) => String(t?.id) === KB_WORKSPACE_ID);
    return new Response(JSON.stringify({ ...body, teams }), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  const guarded = async function guardedFetch(input: Parameters<FetchFn>[0], init?: RequestInit) {
    const url = requestUrl(input);
    const auth = authorizationOf(input, init);

    if (url.hostname !== API_HOST) {
      if (auth) throw new WorkspaceGuardError(`o token não sai para ${url.hostname}`);
      return baseFetch(input, init);
    }
    if (url.protocol !== "https:") throw new WorkspaceGuardError("a API do ClickUp só por https");
    if (!auth) throw new WorkspaceGuardError("chamada à API sem token");

    const method = requestMethod(input, init);
    await assertAllowed(url, method, auth);
    const seg0 = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    await assertReferences(seg0, url, parseJsonBody(init?.body), auth);

    // Redirecionamento não é seguido: levaria o token para uma rota (ou host) não conferida.
    const res = await baseFetch(input, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      throw new WorkspaceGuardError(`a API respondeu com redirecionamento (${res.status}); não seguido`);
    }
    const seg = url.pathname.split("/").filter(Boolean);
    if (seg[1] === "v2" && seg[2] === "team" && seg.length === 3) return onlyKbTeams(res);
    await rememberComments(url, res);
    return res;
  } as FetchFn;

  (guarded as any)[GUARD_MARK] = true;
  return guarded;
}

function parseJsonBody(body: unknown): unknown {
  if (typeof body !== "string") return null; // FormData (anexo) e afins não citam IDs
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export function isGuarded(fn: unknown): boolean {
  return typeof fn === "function" && (fn as any)[GUARD_MARK] === true;
}

/** Instala a trava no fetch global. Idempotente. */
export function installWorkspaceGuard(): void {
  if (isGuarded(globalThis.fetch)) return;
  globalThis.fetch = createGuardedFetch(globalThis.fetch.bind(globalThis));
}
