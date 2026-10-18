/**
 * Ferramentas que a KB acrescenta ao original: cronômetro, mover tarefa de lista e apagar
 * tarefa. Ficam num arquivo próprio para não conflitar ao puxar versões novas do original.
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
