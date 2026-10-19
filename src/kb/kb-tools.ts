/**
 * Ferramentas que a KB acrescenta ao original: cronômetro, mover e apagar tarefa, criar lista e
 * pasta, checklist e tarefa a partir de modelo. Ficam num arquivo próprio para não conflitar ao puxar versões novas do original.
 * Todas passam pelo fetch global, ou seja, pela trava do workspace (workspace-guard.ts).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { KB_WORKSPACE_ID } from "./workspace-guard";

const V2 = "https://api.clickup.com/api/v2";
const V3 = "https://api.clickup.com/api/v3";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

async function call(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: CONFIG.apiKey, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`ClickUp respondeu ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : {};
}

async function run(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
}

function describeEntry(e: any): string {
  if (!e || !e.id) return "Nenhum cronômetro rodando.";
  const start = e.start ? new Date(Number(e.start)).toISOString() : "?";
  const task = e.task ? `${e.task.name} (${e.task.id})` : "sem tarefa";
  return `Cronômetro ${e.id} em ${task}, desde ${start}${e.description ? `: ${e.description}` : ""}`;
}

export function registerKbToolsRead(server: McpServer) {
  server.tool(
    "listTaskTemplates",
    "Lists the task templates available in the KB workspace (id and name), to use with createTaskFromTemplate.",
    {},
    { readOnlyHint: true },
    async () =>
      run(async () => {
        const lines: string[] = [];
        for (let page = 0; page < 20; page++) {
          const templates = (await call(`${V2}/team/${KB_WORKSPACE_ID}/taskTemplate?page=${page}`)).templates ?? [];
          for (const t of templates) lines.push(`- ${t.name} (template_id: ${t.id})`);
          if (templates.length === 0) break;
        }
        return lines.length ? `Modelos de tarefa (${lines.length}):\n${lines.join("\n")}` : "Nenhum modelo de tarefa no workspace.";
      })
  );

  server.tool(
    "getRunningTimer",
    "Shows the time-tracking timer currently running for the token's user in the KB workspace, if any.",
    {},
    { readOnlyHint: true },
    async () => run(async () => describeEntry((await call(`${V2}/team/${KB_WORKSPACE_ID}/time_entries/current`)).data))
  );
}

export function registerKbToolsWrite(server: McpServer) {
  server.tool(
    "startTimer",
    "Starts the time-tracking timer on a task (ClickUp allows one running timer per user; starting a new one stops the previous). Use stopTimer when the work is done.",
    {
      task_id: z.string().min(1).describe("The task to track time on"),
      description: z.string().optional().describe("Optional note for the time entry"),
      billable: z.boolean().optional().describe("Mark the entry as billable"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async ({ task_id, description, billable }) =>
      run(async () => {
        const body: Record<string, unknown> = { tid: task_id };
        if (description) body.description = description;
        if (billable !== undefined) body.billable = billable;
        const res = await call(`${V2}/team/${KB_WORKSPACE_ID}/time_entries/start`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return `Iniciado. ${describeEntry(res.data)}`;
      })
  );

  server.tool(
    "stopTimer",
    "Stops the running time-tracking timer and returns the saved time entry.",
    {},
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async () =>
      run(async () => {
        const e = (await call(`${V2}/team/${KB_WORKSPACE_ID}/time_entries/stop`, { method: "POST" })).data;
        const minutes = e?.duration ? Math.round(Number(e.duration) / 60000) : 0;
        return `Parado. ${minutes} min registrados na entrada ${e?.id ?? "?"} (${e?.task?.name ?? "sem tarefa"}).`;
      })
  );

  server.tool(
    "createList",
    "Creates a list in a space (folderless) or inside a folder. Give exactly one of space_id or folder_id.",
    {
      name: z.string().min(1).describe("List name"),
      space_id: z.string().optional().describe("Space to create the list in (folderless list)"),
      folder_id: z.string().optional().describe("Folder to create the list in"),
      content: z.string().optional().describe("Optional list description (markdown)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async ({ name, space_id, folder_id, content }) =>
      run(async () => {
        if (!!space_id === !!folder_id) throw new Error("Informe exatamente um: space_id ou folder_id.");
        const parent = space_id ? `space/${encodeURIComponent(space_id)}` : `folder/${encodeURIComponent(folder_id!)}`;
        const body: Record<string, unknown> = { name };
        if (content) body.markdown_content = content;
        const list = await call(`${V2}/${parent}/list`, { method: "POST", body: JSON.stringify(body) });
        return [
          `Lista criada: ${list.name} (list_id: ${list.id})`,
          `url: https://app.clickup.com/${KB_WORKSPACE_ID}/v/li/${list.id}`,
          `space: ${list.space?.name ?? "?"} (${list.space?.id ?? "?"})${list.folder?.hidden === false ? `, pasta: ${list.folder.name}` : ""}`,
          `statuses: ${(list.statuses ?? []).map((st: any) => st.status).join(", ") || "padrão do espaço"}`,
        ].join("\n");
      })
  );

  server.tool(
    "createFolder",
    "Creates a folder in a space, or a subfolder inside another folder (parent_folder_id; subfolders must be enabled in the workspace).",
    {
      space_id: z.string().min(1).describe("Space to create the folder in"),
      name: z.string().min(1).describe("Folder name"),
      parent_folder_id: z.string().optional().describe("Optional parent folder, to create a subfolder"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async ({ space_id, name, parent_folder_id }) =>
      run(async () => {
        const body: Record<string, unknown> = { name };
        if (parent_folder_id) body.parent_folder_id = parent_folder_id;
        const folder = await call(`${V2}/space/${encodeURIComponent(space_id)}/folder`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return `Pasta criada: ${folder.name} (folder_id: ${folder.id}) no espaço ${folder.space?.name ?? space_id}.`;
      })
  );

  server.tool(
    "createChecklist",
    "Adds a checklist to a task, optionally with items (one call per item).",
    {
      task_id: z.string().min(1).describe("The task to add the checklist to"),
      name: z.string().min(1).describe("Checklist name"),
      items: z.array(z.string().min(1)).optional().describe("Optional item names, in order"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async ({ task_id, name, items }) =>
      run(async () => {
        const created = await call(`${V2}/task/${encodeURIComponent(task_id)}/checklist`, {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        const checklistId = created.checklist?.id;
        if (!checklistId) throw new Error("O ClickUp não devolveu o ID da checklist.");
        const added: string[] = [];
        for (const item of items ?? []) {
          await call(`${V2}/checklist/${encodeURIComponent(checklistId)}/checklist_item`, {
            method: "POST",
            body: JSON.stringify({ name: item }),
          });
          added.push(item);
        }
        return `Checklist "${name}" (checklist_id: ${checklistId}) criada na tarefa ${task_id} com ${added.length} item(ns)${added.length ? `:\n${added.map((i) => `- [ ] ${i}`).join("\n")}` : "."}`;
      })
  );

  server.tool(
    "createTaskFromTemplate",
    "Creates a task in a list from a task template of the KB workspace (see listTaskTemplates).",
    {
      list_id: z.string().min(1).describe("The list to create the task in"),
      template_id: z.string().min(1).describe("Template ID from listTaskTemplates"),
      name: z.string().min(1).describe("Name of the new task"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async ({ list_id, template_id, name }) =>
      run(async () => {
        const res = await call(
          `${V2}/list/${encodeURIComponent(list_id)}/taskTemplate/${encodeURIComponent(template_id)}`,
          { method: "POST", body: JSON.stringify({ name }) }
        );
        const id = res.id ?? res.task?.id;
        return `Tarefa criada a partir do modelo ${template_id}: ${name}${id ? ` (task_id: ${id}, https://app.clickup.com/t/${id})` : ""}.`;
      })
  );

  server.tool(
    "moveTask",
    "Moves a task to another list (changes its home list). Statuses are mapped by name; a status missing in the target list may fall back to the list default.",
    {
      task_id: z.string().min(1).describe("The task to move"),
      list_id: z.string().min(1).describe("The destination list ID"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async ({ task_id, list_id }) =>
      run(async () => {
        await call(`${V3}/workspaces/${KB_WORKSPACE_ID}/tasks/${encodeURIComponent(task_id)}/home_list/${encodeURIComponent(list_id)}`, {
          method: "PUT",
        });
        return `Tarefa ${task_id} movida para a lista ${list_id}.`;
      })
  );

  server.tool(
    "deleteTask",
    "Permanently deletes a task. Destructive: only use when the user explicitly asked to delete this task (e.g. a test task). Prefer changing the status to close a task.",
    {
      task_id: z.string().min(1).describe("The task to delete"),
      confirm_name: z
        .string()
        .min(1)
        .describe("The exact current name of the task, as a safeguard against deleting the wrong ID"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async ({ task_id, confirm_name }) =>
      run(async () => {
        const task = await call(`${V2}/task/${encodeURIComponent(task_id)}`);
        if (task.name !== confirm_name) {
          throw new Error(`Nada apagado: o nome da tarefa ${task_id} é "${task.name}", não "${confirm_name}".`);
        }
        await call(`${V2}/task/${encodeURIComponent(task_id)}`, { method: "DELETE" });
        return `Tarefa ${task_id} ("${task.name}") apagada.`;
      })
  );
}
