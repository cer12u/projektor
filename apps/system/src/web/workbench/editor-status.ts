// @module workbench
// @role model
import {type SaveState} from './edit-contracts';
export const labels:Record<SaveState,string>={clean:'保存済み',dirty:'未保存',saving:'保存中',unknown:'結果未確認',conflict:'競合',reauth:'再認証が必要',blocked:'操作を拒否',invalid:'入力の確認が必要'};
