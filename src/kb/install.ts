/**
 * Importado como PRIMEIRA linha do src/index.ts: instala a trava do workspace da KB antes de
 * qualquer módulo fazer chamada à API. O teste kb-install.test.ts reprova se deixar de ser.
 */
import { installWorkspaceGuard } from "./workspace-guard";

installWorkspaceGuard();
