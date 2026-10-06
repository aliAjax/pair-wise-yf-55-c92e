import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { simulateMigration, threeWayMerge, validateRules } from './domain';

export type FieldType = 'text' | 'number' | 'select' | 'date';
export interface FormField { id: string; label: string; type: FieldType; required: boolean; options?: string[]; }
export interface LinkRule { id: string; fieldId: string; operator: 'equals' | 'notEmpty'; value: string; effect: 'show' | 'require'; targetId: string; invalid?: boolean; reason?: string; }
export interface FormVersion { id: string; label: string; createdAt: string; fields: FormField[]; rules: LinkRule[]; }
export interface Snapshot { id: string; versionId: string; label: string; data: Record<string, string>; }
export interface ConflictItem { id: string; kind: 'field' | 'rule'; itemId: string; ours: FormField | LinkRule | null; theirs: FormField | LinkRule | null; reason: string; }
export interface DraftState { revision: number; fields: FormField[]; rules: LinkRule[]; }
export interface MigrationReport { gaps: string[]; removed: string[]; changed: string[]; canMigrate: boolean; }

interface DirtyDraft {
  tabId: string;
  fields: FormField[];
  rules: LinkRule[];
  baseRevision: number;
  baseFields: FormField[];
  baseRules: LinkRule[];
}

interface SchemaState {
  versions: FormVersion[];
  activeVersionId: string;
  previewVersionId: string;
  draft: DraftState;
  dirtyDraft: DirtyDraft | null;
  baseRevision: number;
  baseFields: FormField[];
  baseRules: LinkRule[];
  conflicts: ConflictItem[];
  dirty: boolean;
  publishBlocked: string[] | null;
  remoteRevision: number | null;
  snapshots: Snapshot[];
}
type RootShape = { schema: SchemaState };

const STORAGE_KEY = 'yf55-schema-state';

function getTabId(): string {
  try {
    let id = sessionStorage.getItem('yf55-tab-id');
    if (!id) {
      id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem('yf55-tab-id', id);
    }
    return id;
  } catch {
    return 'default';
  }
}

const initial: SchemaState = {
  activeVersionId: 'v2',
  previewVersionId: 'v2',
  draft: {
    revision: 1,
    fields: [
      { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
      { id: 'name', label: '申请名称', type: 'text', required: true },
      { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
      { id: 'amount', label: '申请金额', type: 'number', required: true },
      { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false }
    ],
    rules: [
      { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
      { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' }
    ]
  },
  dirtyDraft: null,
  baseRevision: 1,
  baseFields: [],
  baseRules: [],
  conflicts: [],
  dirty: false,
  publishBlocked: null,
  remoteRevision: null,
  versions: [
    {
      id: 'v1', label: '费用申请 v1', createdAt: '2026-08-12',
      fields: [
        { id: 'name', label: '申请名称', type: 'text', required: true },
        { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
        { id: 'amount', label: '申请金额', type: 'number', required: true }
      ], rules: []
    },
    {
      id: 'v2', label: '费用申请 v2', createdAt: '2026-09-28',
      fields: [
        { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
        { id: 'name', label: '申请名称', type: 'text', required: true },
        { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
        { id: 'amount', label: '申请金额', type: 'number', required: true },
        { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false }
      ],
      rules: [
        { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
        { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' }
      ]
    }
  ],
  snapshots: [
    { id: 's1', versionId: 'v1', label: '八月培训预算', data: { name: '培训预算', department: '财务', amount: '12000' } },
    { id: 's2', versionId: 'v1', label: '市场活动费用', data: { name: '新品活动', department: '市场', amount: '58000' } }
  ]
};

function cloneDraft(draft: DraftState): DraftState {
  return { revision: draft.revision, fields: structuredClone(draft.fields), rules: structuredClone(draft.rules) };
}

function readCommitted(): SchemaState {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as SchemaState;
  } catch { /* ignore */ }
  return structuredClone(initial);
}

function writeCommitted(state: SchemaState) {
  try {
    const { baseRevision: _br, baseFields: _bf, baseRules: _br2, ...persisted } = state;
    void _br; void _bf; void _br2;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch { /* ignore */ }
}

/** 只写未保存草稿（dirtyDraft），不动已提交的 draft，避免把对方刚保存的内容盖掉 */
function writeDirtyDraft(state: SchemaState) {
  try {
    const committed = readCommitted();
    committed.dirtyDraft = state.dirtyDraft;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(committed));
  } catch { /* ignore */ }
}

/** 标记有未保存改动：记录打开时的修订号和快照，供保存时三方合并 */
function markDirty(state: SchemaState) {
  state.dirty = true;
  state.dirtyDraft = {
    tabId: getTabId(),
    fields: structuredClone(state.draft.fields),
    rules: structuredClone(state.draft.rules),
    baseRevision: state.baseRevision,
    baseFields: structuredClone(state.baseFields),
    baseRules: structuredClone(state.baseRules)
  };
  writeDirtyDraft(state);
}

/** 保存成功后：以当前草稿为新基准，清空未保存标记 */
function markSaved(state: SchemaState) {
  state.baseRevision = state.draft.revision;
  state.baseFields = structuredClone(state.draft.fields);
  state.baseRules = structuredClone(state.draft.rules);
  state.dirty = false;
  state.dirtyDraft = null;
}

function loadState(): SchemaState {
  const base = structuredClone(initial);
  const tab = getTabId();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<SchemaState>;
      if (saved.versions) base.versions = saved.versions;
      if (saved.activeVersionId) base.activeVersionId = saved.activeVersionId;
      if (saved.previewVersionId) base.previewVersionId = saved.previewVersionId;
      if (saved.snapshots) base.snapshots = saved.snapshots;
      if (saved.draft) base.draft = cloneDraft(saved.draft);
      if (saved.conflicts) base.conflicts = saved.conflicts;
    }
  } catch { /* ignore */ }

  // 恢复本标签页未保存的草稿（刷新不丢）；若对方已保存更新则丢弃旧草稿
  const dirty = base.dirtyDraft;
  if (dirty && dirty.tabId === tab && dirty.baseRevision === base.draft.revision) {
    base.draft.fields = structuredClone(dirty.fields);
    base.draft.rules = structuredClone(dirty.rules);
    base.dirty = true;
  } else {
    base.dirtyDraft = null;
    base.dirty = false;
  }
  base.baseRevision = base.draft.revision;
  base.baseFields = structuredClone(base.draft.fields);
  base.baseRules = structuredClone(base.draft.rules);
  base.conflicts = base.conflicts ?? [];
  base.publishBlocked = null;
  base.remoteRevision = null;
  return base;
}

const slice = createSlice({
  name: 'schema',
  initialState: loadState(),
  reducers: {
    reorderFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const { activeId, overId } = action.payload;
      const from = state.draft.fields.findIndex((f) => f.id === activeId);
      const to = state.draft.fields.findIndex((f) => f.id === overId);
      if (from < 0 || to < 0) return;
      const [moved] = state.draft.fields.splice(from, 1);
      state.draft.fields.splice(to, 0, moved);
      markDirty(state);
    },
    addField(state) {
      const id = `field-${Date.now()}`;
      state.draft.fields.push({ id, label: '新字段', type: 'text', required: false });
      state.draft.rules = validateRules(state.draft.fields, state.draft.rules);
      markDirty(state);
    },
    updateField(state, action: PayloadAction<{ id: string; changes: Partial<FormField> }>) {
      const field = state.draft.fields.find((f) => f.id === action.payload.id);
      if (!field) return;
      Object.assign(field, action.payload.changes);
      // 字段一改动，引用它的联动立即失效重算
      state.draft.rules = validateRules(state.draft.fields, state.draft.rules);
      markDirty(state);
    },
    removeField(state, action: PayloadAction<string>) {
      state.draft.fields = state.draft.fields.filter((f) => f.id !== action.payload);
      state.draft.rules = validateRules(state.draft.fields, state.draft.rules);
      markDirty(state);
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id' | 'invalid' | 'reason'>>) {
      const rule: LinkRule = { ...action.payload, id: `rule-${Date.now()}` };
      state.draft.rules.push(rule);
      state.draft.rules = validateRules(state.draft.fields, state.draft.rules);
      markDirty(state);
    },
    removeRule(state, action: PayloadAction<string>) {
      state.draft.rules = state.draft.rules.filter((r) => r.id !== action.payload);
      markDirty(state);
    },
    /**
     * 保存草稿：带上打开时的修订号。
     * 若已被别人动过（committed.revision !== baseRevision），逐条合并：
     * 没动过的照对方结果走，两边都改过的留两份等人挑。
     */
    saveDraft(state) {
      const committed = readCommitted();
      const base = { fields: state.baseFields, rules: state.baseRules };
      const ours = { fields: state.draft.fields, rules: state.draft.rules };
      const theirs = { fields: committed.draft.fields, rules: committed.draft.rules };

      const fieldMerge = threeWayMerge(base.fields, ours.fields, theirs.fields, 'field');
      const ruleMerge = threeWayMerge(base.rules, ours.rules, theirs.rules, 'rule');
      state.draft.fields = fieldMerge.items;
      state.draft.rules = validateRules(fieldMerge.items, ruleMerge.items);
      state.conflicts = [...fieldMerge.conflicts, ...ruleMerge.conflicts];
      state.draft.revision = committed.draft.revision + 1;

      if (state.conflicts.length === 0) {
        markSaved(state);
      } else {
        // 有冲突时仍需保存合并结果，但保持未保存状态等人挑
        state.dirty = true;
        state.dirtyDraft = {
          tabId: getTabId(),
          fields: state.draft.fields,
          rules: state.draft.rules,
          baseRevision: state.draft.revision,
          baseFields: structuredClone(state.draft.fields),
          baseRules: structuredClone(state.draft.rules)
        };
        state.baseRevision = state.draft.revision;
        state.baseFields = structuredClone(state.draft.fields);
        state.baseRules = structuredClone(state.draft.rules);
      }
      state.remoteRevision = null;
      writeCommitted(state);
    },
    /** 冲突解决：挑我方或对方的版本 */
    resolveConflict(state, action: PayloadAction<{ id: string; choice: 'ours' | 'theirs' }>) {
      const conflict = state.conflicts.find((c) => c.id === action.payload.id);
      if (!conflict) return;
      const chosen = action.payload.choice === 'ours' ? conflict.ours : conflict.theirs;
      if (conflict.kind === 'field') {
        if (chosen) {
          const idx = state.draft.fields.findIndex((f) => f.id === conflict.itemId);
          if (idx >= 0) state.draft.fields[idx] = chosen as FormField;
          else state.draft.fields.push(chosen as FormField);
        } else {
          state.draft.fields = state.draft.fields.filter((f) => f.id !== conflict.itemId);
        }
      } else {
        if (chosen) {
          const idx = state.draft.rules.findIndex((r) => r.id === conflict.itemId);
          if (idx >= 0) state.draft.rules[idx] = chosen as LinkRule;
          else state.draft.rules.push(chosen as LinkRule);
        } else {
          state.draft.rules = state.draft.rules.filter((r) => r.id !== conflict.itemId);
        }
      }
      state.draft.rules = validateRules(state.draft.fields, state.draft.rules);
      state.conflicts = state.conflicts.filter((c) => c.id !== action.payload.id);
      markDirty(state);
    },
    /** 发布会话：先看失效规则，有问题就拦下并列出原因 */
    publishVersion(state) {
      state.draft.rules = validateRules(state.draft.fields, state.draft.rules);
      const invalid = state.draft.rules.filter((r) => r.invalid);
      if (invalid.length > 0) {
        state.publishBlocked = invalid.map((r) => `${r.fieldId} → ${r.targetId}：${r.reason}`);
        return;
      }
      const id = `v${state.versions.length + 1}`;
      state.versions.push({
        id,
        label: `费用申请 ${id}`,
        createdAt: new Date().toISOString().slice(0, 10),
        fields: structuredClone(state.draft.fields),
        rules: structuredClone(state.draft.rules)
      });
      state.activeVersionId = id;
      state.previewVersionId = id;
      state.draft.revision += 1;
      state.conflicts = [];
      state.publishBlocked = null;
      markSaved(state);
      writeCommitted(state);
    },
    dismissPublishBlock(state) { state.publishBlocked = null; },
    selectPreview(state, action: PayloadAction<string>) { state.previewVersionId = action.payload; },
    /** 另一标签页已保存更新 */
    remoteUpdated(state, action: PayloadAction<number>) { state.remoteRevision = action.payload; },
    /** 以对方已保存的最新版为准重新加载 */
    reloadFromRemote(state) {
      const committed = readCommitted();
      state.draft.fields = structuredClone(committed.draft.fields);
      state.draft.rules = validateRules(committed.draft.fields, committed.draft.rules);
      state.draft.revision = committed.draft.revision;
      state.conflicts = [];
      state.remoteRevision = null;
      markSaved(state);
    },
    /** 演示用：模拟另一个标签页并发保存了一版 */
    simulateConcurrentEdit(state) {
      const committed = readCommitted();
      const theirs = cloneDraft(committed.draft);
      theirs.fields.push({ id: `field-concurrent-${Date.now()}`, label: '他标签页新增字段', type: 'text', required: false });
      if (theirs.fields[0]) theirs.fields[0].label += '（他改）';
      theirs.revision = committed.draft.revision + 1;
      const next: SchemaState = { ...committed, draft: theirs };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      state.remoteRevision = theirs.revision;
    },
    replaceState(_state, action: PayloadAction<SchemaState>) { return action.payload; }
  }
});

export const schemaApi = createApi({
  reducerPath: 'schemaApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    schemaHistory: builder.query<FormVersion[], string>({
      queryFn: (versionId) => {
        const state = readCommitted();
        return { data: state.versions.filter((item) => item.id !== versionId).slice(-3) };
      }
    })
  })
});

export const { useSchemaHistoryQuery } = schemaApi;
export const {
  addField, addRule, dismissPublishBlock, publishVersion, reorderFields,
  reloadFromRemote, removeField, removeRule, resolveConflict, saveDraft,
  selectPreview, simulateConcurrentEdit, updateField, remoteUpdated, replaceState
} = slice.actions;

export const store = configureStore({
  reducer: { schema: slice.reducer, [schemaApi.reducerPath]: schemaApi.reducer },
  middleware: (getDefault) => getDefault().concat(schemaApi.middleware)
});

if (typeof window !== 'undefined') {
  // 跨标签页：另一标签页保存后，本方收到修订号变更通知
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const next = JSON.parse(event.newValue) as SchemaState;
      const current = (store.getState() as RootShape).schema;
      if (next.draft && next.draft.revision > current.baseRevision) {
        store.dispatch(remoteUpdated(next.draft.revision));
      }
    } catch { /* ignore */ }
  });
}

export type RootState = RootShape;

/** 迁移模拟：旧数据按所属版本解释，迁移到当前草稿 */
export function simulateMigrationReport(state: SchemaState, snapshotId: string): MigrationReport | null {
  const snapshot = state.snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) return null;
  const fromVersion = state.versions.find((item) => item.id === snapshot.versionId);
  return simulateMigration(snapshot, fromVersion, state.draft.fields);
}
