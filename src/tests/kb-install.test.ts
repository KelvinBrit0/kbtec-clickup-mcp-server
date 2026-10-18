import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { loadApiKey } from "../kb/token";

/**
 * Conferências estáticas da camada da KB: protegem a trava contra uma mudança (nossa ou
 * puxada do original) que a desligue sem ninguém perceber.
 */
const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "tests" ? [] : sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

test("a trava é o primeiro import do servidor", () => {
  const imports = readFileSync(join(SRC, "index.ts"), "utf8")
    .split("\n")
    .filter((line) => /^\s*import\s/.test(line));
  assert.match(imports[0], /^import "\.\/kb\/install";/);
});

test("nenhum código fala com a rede por fora do fetch global (que tem a trava)", () => {
  const bypass = /from\s+["'](undici|node:https?|https?|node:net|net|axios|node-fetch)["']|require\(["'](undici|https?|node:https?)["']\)/;
  const offenders = sourceFiles(SRC).filter((f) => bypass.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

test("nenhum código guarda uma cópia do fetch antes da trava", () => {
  const copy = /=\s*(globalThis\.)?fetch\s*[;,)]|\bfetch\.bind\(/;
  const offenders = sourceFiles(SRC)
    .filter((f) => !f.endsWith(join("kb", "workspace-guard.ts")))
    .filter((f) => copy.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

test("token: variável de ambiente, depois arquivo indicado", () => {
  assert.equal(loadApiKey({ CLICKUP_API_KEY: " pk_env \n" }), "pk_env");
  assert.equal(loadApiKey({ CLICKUP_API_KEY_FILE: join(SRC, "nao-existe") }), undefined);
});
