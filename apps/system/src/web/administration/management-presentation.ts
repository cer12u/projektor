// @module administration
// @role model
import type {Permission} from "../../modules/identity/dto";
import {HttpError} from '../platform/index';
import {type ManagementRecord} from './management-model';
export const labels:Record<ManagementRecord['kind'],string>={principal:'主体',membership:'プロジェクトの所属',credential:'API資格情報',scope:'プロジェクトの資格scope'};

export const permissionLabels:Record<Permission,string>={view:'閲覧',edit:'編集',assign:'担当変更',transition:'状態変更',execute:'実行',manage:'管理'};

export function time(seconds:number|null){return seconds===null?'なし':new Date(seconds*1000).toLocaleString();}

export function issue(error:unknown){if(error instanceof HttpError){if(error.status===401)return 'セッションが失効しました。再ログイン後、操作結果を確認してください。';if(error.status===403)return '現在の管理権限では確認・変更できません。送信済み操作が取り消されたとは限りません。';if(error.status===409)return '対象が変更されています。最新版を確認してから操作を決めてください。';if(error.status===400)return Object.values(error.fields??{}).join(' ')||'入力を確認してください。';}return '結果を確認できません。入力と操作IDを保持し、自動再送を停止しています。';}
