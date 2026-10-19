# kbtec-clickup-mcp-server — a camada da KB

Fork do [hauptsacheNet/clickup-mcp](https://github.com/hauptsacheNet/clickup-mcp) (MIT) usado pela KB
Tecnologia para o backlog no ClickUp. Decisão e porquê: ADR-038 do `kb-business-os`.

O que este fork acrescenta (tudo em `src/kb/`):

- **Trava do workspace** (`workspace-guard.ts`): substitui o `fetch` global e só deixa passar chamada a
  objeto do workspace da KB (`90171602543`, escrito no código). Rota desconhecida é negada; o token
  nunca sai para outro host. Testes: `src/tests/kb-*.test.ts`.
- **Ferramentas**: `startTimer`, `stopTimer`, `getRunningTimer`, `moveTask`, `deleteTask`, `createList`,
  `createFolder`, `createChecklist`, `listTaskTemplates`, `createTaskFromTemplate`. Opção nova em campo de
  lista suspensa não existe na API pública do ClickUp.
- **Token por arquivo** (`token.ts`): `CLICKUP_API_KEY`, `CLICKUP_API_KEY_FILE` ou
  `~/.config/clickup/kb-bot-token` (token do robô que só enxerga a KB).

```bash
npm install && npm run build && npm test
claude mcp add kbtec-kelvin-clickup -s user -- node <caminho>/dist/index.js
```

Puxar o original: `git fetch upstream && git merge upstream/main`, depois `npm test` (os testes
`kb-install` reprovam se a trava deixar de ser o primeiro import ou se algo falar com a rede por fora).
