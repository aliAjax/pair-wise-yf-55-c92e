import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  applyConflictChoices,
  changedFieldIds,
  cloneFields,
  cloneRules,
  cloneWorkFields,
  cloneWorkRules,
  isDirtySession,
  recomputeRules,
  sameItems,
  threeWayMerge,
  type FormField,
  type LinkRule,
  type ProposedMerge,
  type WorkField,
  type WorkRule,
} from './schemaLogic';

export type { FieldType, FormField, LinkRule, WorkField, WorkRule } from './schemaLogic';

export interface FormVersion {
  id: string;
  label: string;
  createdAt: string;
  fields: FormField[];
  rules: LinkRule[];
}

export interface Snapshot {
  id: string;
  versionId: string;
  label: string;
  data: Record<string, string>;
  submittedAt: string;
}

export interface Draft {
  id: string;
  label: string;
  revision: number;
  parentRevision?: number;
  fields: WorkField[];
  rules: WorkRule[];
  updatedAt: string;
}

export interface WorkSession {
  id: string;
  label: string;
  baseRevision: number;
  baseFields: WorkField[];
  baseRules: WorkRule[];
  fields: WorkField[];
  rules: WorkRule[];
  pendingMerge?: ProposedMerge;
  message?: string;
}

interface PersistedState {
  versions: FormVersion[];
  snapshots: Snapshot[];
  activeVersionId: string;
  runtimeVersionId: string;
  draft: Draft;
}

export interface SchemaState extends PersistedState {
  sessions: Record<string, WorkSession>;
  selectedSessionId: string;
}

export type RootShape = { schema: SchemaState };

const v1Fields: FormField[] = [
  { id: 'name', label: '申请名称', type: 'text', required: true },
  { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
  { id: 'channel', label: '获客渠道', type: 'text', required: false },
  { id: 'amount', label: '申请金额', type: 'number', required: true },
];

const v1Rules: LinkRule[] = [];

const v2Fields: FormField[] = [
  { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
  { id: 'name', label: '申请名称', type: 'text', required: true },
  { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
  { id: 'amount', label: '申请金额', type: 'number', required: true },
  { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false },
];

const v2Rules: LinkRule[] = [
  { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
  { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' },
];

function asWorkRules(rules: LinkRule[]): WorkRule[] {
  return rules.map((rule) => ({ ...rule, status: 'valid' }));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function makeSession(id: string, label: string, draft: Draft): WorkSession {
  return {
    id,
    label,
    baseRevision: draft.revision,
    baseFields: cloneWorkFields(draft.fields),
    baseRules: cloneWorkRules(draft.rules),
    fields: cloneWorkFields(draft.fields),
    rules: cloneWorkRules(draft.rules),
    message: `已打开修订号 r${draft.revision}`,
  };
}

function createInitial(): SchemaState {
  const versions: FormVersion[] = [
    { id: 'v1', label: '费用申请 v1', createdAt: '2026-08-12', fields: v1Fields, rules: v1Rules },
    { id: 'v2', label: '费用申请 v2', createdAt: '2026-09-28', fields: v2Fields, rules: v2Rules },
  ];
  const draft: Draft = {
    id: 'draft',
    label: '费用申请 v3 草稿',
    revision: 3,
    fields: v2Fields.map((field) => ({ ...field })),
    rules: asWorkRules(v2Rules),
    updatedAt: today(),
  };
  return {
    versions,
    activeVersionId: 'v2',
    runtimeVersionId: 'v2',
    snapshots: [
      { id: 's1', versionId: 'v1', label: '八月培训预算', submittedAt: '2026-08-20', data: { name: '培训预算', department: '财务', channel: '线下沙龙', amount: '12000' } },
      { id: 's2', versionId: 'v1', label: '市场活动费用', submittedAt: '2026-08-25', data: { name: '新品活动', department: '市场', channel: '门店转介绍', amount: '58000' } },
    ],
    draft,
    sessions: {
      tabA: makeSession('tabA', '标签页 A', draft),
      tabB: makeSession('tabB', '标签页 B', draft),
    },
    selectedSessionId: 'tabA',
  };
}

const initialState = createInitial();
const STORAGE_KEY = 'yf55-schema-server-v2';

function uniqueId(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function refreshRuleStatus(session: WorkSession, preserveIds: string[] = []) {
  const changedIds = changedFieldIds(session.baseFields, session.fields);
  session.rules = recomputeRules(session.rules, session.fields, changedIds, { preserveIds });
}

function fastForwardIfClean(state: SchemaState, session: WorkSession) {
  if (session.pendingMerge || isDirtySession(session)) return;
  session.baseRevision = state.draft.revision;
  session.baseFields = cloneWorkFields(state.draft.fields);
  session.baseRules = cloneWorkRules(state.draft.rules);
  session.fields = cloneWorkFields(state.draft.fields);
  session.rules = cloneWorkRules(state.draft.rules);
  session.message = `已同步到最新修订号 r${state.draft.revision}`;
}

function commitDraft(state: SchemaState, fields: WorkField[], rules: WorkRule[], session: WorkSession) {
  const changedIds = changedFieldIds(session.baseFields, fields);
  const baseRuleIds = new Set(session.baseRules.map((rule) => rule.id));
  const preserveIds = rules.filter((rule) => !baseRuleIds.has(rule.id)).map((rule) => rule.id);
  const nextRules = recomputeRules(rules, fields, changedIds, { preserveIds });
  state.draft = {
    ...state.draft,
    parentRevision: state.draft.revision,
    revision: state.draft.revision + 1,
    fields: cloneWorkFields(fields),
    rules: cloneWorkRules(nextRules),
    updatedAt: today(),
  };
  session.baseRevision = state.draft.revision;
  session.baseFields = cloneWorkFields(fields);
  session.baseRules = cloneWorkRules(nextRules);
  session.fields = cloneWorkFields(fields);
  session.rules = cloneWorkRules(nextRules);
  session.pendingMerge = undefined;
  session.message = `已保存为修订号 r${state.draft.revision}`;

  for (const other of Object.values(state.sessions)) {
    if (other.id === session.id) continue;
    fastForwardIfClean(state, other);
  }
}

interface FieldPatch extends Partial<Omit<FormField, 'id'>> {}
interface RulePatch extends Partial<Omit<LinkRule, 'id'>> {}

const slice = createSlice({
  name: 'schema',
  initialState: initialState,
  reducers: {
    selectSession(state, action: PayloadAction<string>) {
      state.selectedSessionId = action.payload;
    },
    addField(state) {
      const session = state.sessions[state.selectedSessionId];
      if (!session || session.pendingMerge) return;
      const id = uniqueId('field');
      session.fields.push({ id, label: '新字段', type: 'text', required: false });
      refreshRuleStatus(session);
      session.message = '本地新增尚未保存';
    },
    updateField(state, action: PayloadAction<{ id: string; patch: FieldPatch }>) {
      const session = state.sessions[state.selectedSessionId];
      if (!session || session.pendingMerge) return;
      const field = session.fields.find((item) => item.id === action.payload.id);
      if (!field) return;
      Object.assign(field, action.payload.patch);
      if (field.type !== 'select') delete field.options;
      refreshRuleStatus(session);
      session.message = '本地修改尚未保存';
    },
    deleteField(state, action: PayloadAction<string>) {
      const session = state.sessions[state.selectedSessionId];
      if (!session || session.pendingMerge) return;
      session.fields = session.fields.filter((field) => field.id !== action.payload);
      refreshRuleStatus(session);
      session.message = '本地删除尚未保存';
    },
    reorderFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const session = state.sessions[state.selectedSessionId];
      if (!session || session.pendingMerge) return;
      const from = session.fields.findIndex((item) => item.id === action.payload.activeId);
      const to = session.fields.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = session.fields.splice(from, 1);
      session.fields.splice(to, 0, moved);
      session.message = '本地顺序调整尚未保存';
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      const session = state.sessions[state.selectedSessionId];
      if (!session || session.pendingMerge) return;
      const id = uniqueId('rule');
      session.rules.push({ ...action.payload, id, status: 'valid' });
      refreshRuleStatus(session, [id]);
      session.message = '本地新增联动尚未保存';
    },
    updateRule(state, action: PayloadAction<{ id: string; patch: RulePatch }>) {
      const session = state.sessions[state.selectedSessionId];
      if (!session || session.pendingMerge) return;
      const rule = session.rules.find((item) => item.id === action.payload.id);
      if (!rule) return;
      Object.assign(rule, action.payload.patch);
      refreshRuleStatus(session);
      session.message = '本地修改联动尚未保存';
    },
    deleteRule(state, action: PayloadAction<string>) {
      const session = state.sessions[state.selectedSessionId];
      if (!session || session.pendingMerge) return;
      session.rules = session.rules.filter((rule) => rule.id !== action.payload);
      session.message = '本地删除联动尚未保存';
    },
    acknowledgeStaleRules(state) {
      const session = state.sessions[state.selectedSessionId];
      if (!session || session.pendingMerge) return;
      session.rules = session.rules.map((rule) => rule.status === 'stale' ? { ...rule, status: 'valid', reason: undefined } : rule);
      session.message = '已确认重算后的联动，当前改动仍需保存';
    },
    saveSession(state, action: PayloadAction<string | undefined>) {
      const session = state.sessions[action.payload ?? state.selectedSessionId];
      if (!session || session.pendingMerge) return;
      const saveMerged = (theirFields: WorkField[], theirRules: WorkRule[], serverRevision: number) => {
        const proposal = threeWayMerge(
          session.baseFields,
          session.baseRules,
          cloneWorkFields(session.fields),
          cloneWorkRules(session.rules),
          cloneWorkFields(theirFields),
          cloneRules(theirRules),
          serverRevision,
        );

        if (!proposal.conflicts.length) {
          session.message = `检测到修订号 r${serverRevision}，无冲突项已自动合并`;
          commitDraft(state, proposal.fields, proposal.rules, session);
          return;
        }

        session.pendingMerge = proposal;
        session.message = `修订号已从 r${session.baseRevision} 变为 r${serverRevision}，有 ${proposal.conflicts.length} 项两边都改过，需要人工选择`;
      };

      if (session.baseRevision === state.draft.revision) {
        if (!isDirtySession(session)) {
          session.message = `没有本地改动，当前已是修订号 r${state.draft.revision}`;
          return;
        }
        commitDraft(state, session.fields, session.rules, session);
        return;
      }

      const currentIsOurSuccessor = state.draft.parentRevision === session.baseRevision &&
        sameItems(state.draft.fields, session.fields) &&
        sameItems(state.draft.rules, session.rules);
      if (currentIsOurSuccessor) {
        session.baseRevision = state.draft.revision;
        session.baseFields = cloneWorkFields(state.draft.fields);
        session.baseRules = cloneWorkRules(state.draft.rules);
        session.message = `本页保存的修订号 r${state.draft.revision} 已在另一标签页生效`;
        return;
      }

      saveMerged(state.draft.fields, state.draft.rules, state.draft.revision);
    },
    chooseConflict(state, action: PayloadAction<{ id: string; kind: 'field' | 'rule'; choice: 'ours' | 'theirs' }>) {
      const session = state.sessions[state.selectedSessionId];
      if (!session?.pendingMerge) return;
      const conflict = session.pendingMerge.conflicts.find(
        (item) => item.id === action.payload.id && item.kind === action.payload.kind,
      );
      if (conflict) conflict.choice = action.payload.choice;
    },
    resolveConflicts(state) {
      const session = state.sessions[state.selectedSessionId];
      if (!session?.pendingMerge) return;

      let proposal = session.pendingMerge;
      if (proposal.serverRevision !== state.draft.revision) {
        proposal = threeWayMerge(
          session.baseFields,
          session.baseRules,
          cloneWorkFields(session.fields),
          cloneWorkRules(session.rules),
          cloneWorkFields(state.draft.fields),
          cloneRules(state.draft.rules),
          state.draft.revision,
        );
      }
      if (proposal.conflicts.some((conflict) => !conflict.choice)) {
        session.pendingMerge = proposal;
        session.message = '仍有冲突项未选择';
        return;
      }
      const resolved = applyConflictChoices(proposal);
      if (!resolved) return;
      session.message = '冲突已全部选择，正在保存合并结果';
      commitDraft(state, resolved.fields, resolved.rules, session);
    },
    cancelMerge(state) {
      const session = state.sessions[state.selectedSessionId];
      if (!session) return;
      session.pendingMerge = undefined;
      session.message = '已取消本次合并，本地改动仍保留';
    },
    refreshSession(state, action: PayloadAction<string | undefined>) {
      const session = state.sessions[action.payload ?? state.selectedSessionId];
      if (!session || isDirtySession(session) || session.pendingMerge) return;
      session.baseRevision = state.draft.revision;
      session.baseFields = cloneWorkFields(state.draft.fields);
      session.baseRules = cloneWorkRules(state.draft.rules);
      session.fields = cloneWorkFields(state.draft.fields);
      session.rules = cloneWorkRules(state.draft.rules);
      session.message = `已放弃本地视图并同步 r${state.draft.revision}`;
    },
    publishDraft(state) {
      if (state.draft.rules.some((rule) => rule.status === 'invalid')) return;
      const number = state.versions.length + 1;
      const id = `v${number}`;
      const version: FormVersion = {
        id,
        label: `费用申请 ${id}`,
        createdAt: today(),
        fields: cloneWorkFields(state.draft.fields),
        rules: cloneRules(state.draft.rules),
      };
      state.versions.push(version);
      state.activeVersionId = id;
      state.runtimeVersionId = id;
      state.draft = {
        ...state.draft,
        label: `费用申请 v${number + 1} 草稿`,
        parentRevision: state.draft.revision,
        revision: state.draft.revision + 1,
        fields: cloneWorkFields(version.fields),
        rules: asWorkRules(version.rules),
        updatedAt: today(),
      };
      for (const session of Object.values(state.sessions)) fastForwardIfClean(state, session);
    },
    setRuntimeVersion(state, action: PayloadAction<string>) {
      state.runtimeVersionId = action.payload;
    },
    addSnapshot(state, action: PayloadAction<{ versionId: string; label: string; data: Record<string, string> }>) {
      state.snapshots.push({
        id: uniqueId('snapshot'),
        versionId: action.payload.versionId,
        label: action.payload.label || `运行态提交 ${state.snapshots.length + 1}`,
        data: action.payload.data,
        submittedAt: today(),
      });
    },
    serverUpdated(state, action: PayloadAction<PersistedState>) {
      const next = action.payload;
      if (
        next.draft.revision === state.draft.revision &&
        sameItems(next.draft.fields, state.draft.fields) &&
        sameItems(next.draft.rules, state.draft.rules)
      ) return;
      state.versions = next.versions;
      state.snapshots = next.snapshots;
      state.activeVersionId = next.activeVersionId;
      state.runtimeVersionId = next.runtimeVersionId;
      state.draft = next.draft;
      for (const session of Object.values(state.sessions)) fastForwardIfClean(state, session);
    },
  },
});

function loadPersisted(): PersistedState | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedState;
  } catch {
    return null;
  }
}

export const store = configureStore({ reducer: { schema: slice.reducer } });
const initialPersisted = loadPersisted();
if (initialPersisted) {
  store.dispatch(slice.actions.serverUpdated(initialPersisted));
  const currentState = store.getState().schema;
  currentState.sessions = {
    tabA: makeSession('tabA', '标签页 A', currentState.draft),
    tabB: makeSession('tabB', '标签页 B', currentState.draft),
  };
  currentState.selectedSessionId = 'tabA';
}

if (typeof window !== 'undefined') {
  const save = () => {
    const state = store.getState().schema;
    const { sessions: _sessions, selectedSessionId: _selected, ...server } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(server));
  };
  save();
  store.subscribe(save);
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      store.dispatch(slice.actions.serverUpdated(JSON.parse(event.newValue) as PersistedState));
    } catch {
      // Ignore mallocal storage writes from other tabs.
    }
  });
}

export const {
  acknowledgeStaleRules,
  addField,
  addRule,
  addSnapshot,
  cancelMerge,
  chooseConflict,
  deleteField,
  deleteRule,
  publishDraft,
  reorderFields,
  resolveConflicts,
  saveSession,
  selectSession,
  serverUpdated,
  setRuntimeVersion,
  updateField,
  updateRule,
  refreshSession,
} = slice.actions;

export type RootState = RootShape;
