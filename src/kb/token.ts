/**
 * De onde vem o token do ClickUp na instalação da KB.
 *
 * O token fica num arquivo que só o usuário do Windows abre (permissão travada com icacls),
 * fora do repositório e fora da configuração do cliente MCP — assim ele não aparece no
 * ~/.claude.json nem em listagem de configuração. Ordem: CLICKUP_API_KEY (testes e quem
 * preferir), CLICKUP_API_KEY_FILE, e o arquivo padrão ~/.config/clickup/kb-bot-token.
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const DEFAULT_TOKEN_FILE = join(homedir(), ".config", "clickup", "kb-bot-token");

export function loadApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CLICKUP_API_KEY) return env.CLICKUP_API_KEY.trim();
  const file = env.CLICKUP_API_KEY_FILE || DEFAULT_TOKEN_FILE;
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8").trim() || undefined;
}
