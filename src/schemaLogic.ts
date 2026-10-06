export type FieldType = 'text' | 'number' | 'select' | 'date';
export type WorkStatus = 'valid' | 'stale' | 'invalid';

export interface FormField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}

export interface LinkRule {
  id: string;
  fieldId: string;
  operator: 'equals' | 'notEmpty';
  value: string;
  effect: 'show' | 'require';
  targetId: string;
}

export interface WorkField extends FormField {
  status?: WorkStatus;
  reason?: string;
}

export interface WorkRule extends LinkRule {
  status?: WorkStatus;
  reason?: string;
}

export interface MergeConflict {
  id: string;
  kind: 'field' | 'rule';
  base?: WorkField | WorkRule;
  ours?: WorkField | WorkRule;
  theirs?: WorkField | WorkRule;
  choice?: 'ours' | 'theirs';
}

export interface ProposedMerge {
  serverRevision: number;
  fields: WorkField[];
  rules: WorkRule[];
  conflicts: MergeConflict[];
  changedFieldIds: string[];
}

export function cloneFields(fields: WorkField[]): WorkField[] {
  return fields.map(({ status: _status, reason: _reason, ...field }) => ({ ...field }));
}

export function cloneRules(rules: WorkRule[]): WorkRule[] {
  return rules.map(({ status: _status, reason: _reason, ...rule }) => ({ ...rule }));
}

export function cloneWorkFields(fields: WorkField[]): WorkField[] {
  return fields.map((field) => ({ ...field }));
}

export function cloneWorkRules(rules: WorkRule[]): WorkRule[] {
  return rules.map((rule) => ({ ...rule }));
}

export function toCanonical<T extends object>(item: T): T {
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) as T;
}

export function sameItem<T extends object>(a?: T, b?: T): boolean {
  if (!a || !b) return false;
  return JSON.stringify(toCanonical(a)) === JSON.stringify(toCanonical(b));
}

export function sameItems<T extends object>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => sameItem(item, b[index]));
}

export function fieldMap(fields: WorkField[]) {
  return new Map(fields.map((field) => [field.id, field]));
}

export function ruleMap(rules: WorkRule[]) {
  return new Map(rules.map((rule) => [rule.id, rule]));
}

interface MergeResult<T extends WorkField | WorkRule> {
  items: T[];
  conflicts: MergeConflict[];
}

function mergeItems<T extends WorkField | WorkRule>(
  kind: 'field' | 'rule',
  baseItems: T[],
  oursItems: T[],
  theirsItems: T[],
): MergeResult<T> {
  const base = new Map(baseItems.map((item) => [item.id, item]));
  const ours = new Map(oursItems.map((item) => [item.id, item]));
  const theirs = new Map(theirsItems.map((item) => [item.id, item]));
  const orderedIds: string[] = [];
  for (const item of oursItems) if (!orderedIds.includes(item.id)) orderedIds.push(item.id);
  for (const item of theirsItems) if (!orderedIds.includes(item.id)) orderedIds.push(item.id);
  for (const item of baseItems) if (!orderedIds.includes(item.id)) orderedIds.push(item.id);

  const items: T[] = [];
  const conflicts: MergeConflict[] = [];

  for (const id of orderedIds) {
    const baseItem = base.get(id);
    const ourItem = ours.get(id);
    const theirItem = theirs.get(id);

    if (!ourItem) {
      if (!baseItem) {
        // 我方没有动过，对方新增的内容直接采纳。
        if (theirItem) items.push(theirItem);
        continue;
      }
      // 我方删除：对方没改就接受删除；对方改了则双方冲突。
      if (theirItem && !sameItem(theirItem, baseItem)) {
        conflicts.push({ id, kind, base: baseItem, theirs: theirItem });
      }
      continue;
    }

    if (!baseItem) {
      // 双方都新增了同一个 ID 但内容不同，需要人工选择。
      if (theirItem && !sameItem(ourItem, theirItem)) {
        conflicts.push({ id, kind, theirs: theirItem, ours: ourItem });
      } else {
        items.push(ourItem);
      }
      continue;
    }

    if (!theirItem) {
      // 对方删除：我方没改就接受删除；我方也改了则双方冲突。
      if (!sameItem(ourItem, baseItem)) {
        conflicts.push({ id, kind, base: baseItem, ours: ourItem });
      }
      continue;
    }

    const oursChanged = !sameItem(ourItem, baseItem);
    const theirsChanged = !sameItem(theirItem, baseItem);
    if (!oursChanged) {
      items.push(theirItem);
    } else if (!theirsChanged || sameItem(ourItem, theirItem)) {
      items.push(ourItem);
    } else {
      conflicts.push({ id, kind, base: baseItem, ours: ourItem, theirs: theirItem });
    }
  }

  return { items, conflicts };
}

export function changedFieldIds(baseFields: WorkField[], mergedFields: WorkField[]): string[] {
  const base = fieldMap(baseFields);
  const current = fieldMap(mergedFields);
  const ids = new Set<string>();
  for (const [id, field] of base) {
    const next = current.get(id);
    if (!next || !sameItem(field, next)) ids.add(id);
  }
  for (const id of current.keys()) if (!base.has(id)) ids.add(id);
  return [...ids];
}

export function recomputeRules(
  rules: WorkRule[],
  fields: WorkField[],
  changedIds: string[],
  options: { preserveIds?: string[] } = {},
): WorkRule[] {
  const preserve = new Set(options.preserveIds ?? []);
  const fieldsById = fieldMap(fields);
  return rules.map((rule) => {
    if (preserve.has(rule.id)) return { ...rule, status: 'valid', reason: undefined };
    const source = fieldsById.get(rule.fieldId);
    const target = fieldsById.get(rule.targetId);
    const reasons: string[] = [];
    let status: WorkStatus = 'valid';

    if (!source) {
      status = 'invalid';
      reasons.push(`引用的源字段 ${rule.fieldId} 已被移除`);
    }
    if (!target) {
      status = 'invalid';
      reasons.push(`引用的目标字段 ${rule.targetId} 已被移除`);
    }
    if (source && rule.operator === 'equals' && source.type === 'select' && source.options?.length) {
      if (!source.options.includes(rule.value)) {
        status = 'invalid';
        reasons.push(`选项“${rule.value}”已不存在于字段“${source.label}”`);
      }
    }
    if (source && target) {
      const touched: string[] = [];
      if (changedIds.includes(rule.fieldId)) touched.push(`源字段“${source.label}”`);
      if (changedIds.includes(rule.targetId)) touched.push(`目标字段“${target.label}”`);
      if (touched.length && status !== 'invalid') {
        status = 'stale';
        reasons.push(`${touched.join('、')}发生变化，联动已按当前定义重新计算，请发布前确认`);
      }
    }

    return { ...rule, status, reason: reasons.join('；') || undefined };
  });
}

export function threeWayMerge(
  baseFields: WorkField[],
  baseRules: WorkRule[],
  ourFields: WorkField[],
  ourRules: WorkRule[],
  theirFields: WorkField[],
  theirRules: WorkRule[],
  serverRevision: number,
): ProposedMerge {
  const fieldsResult = mergeItems('field', baseFields, ourFields, theirFields);
  const rulesResult = mergeItems('rule', baseRules, ourRules, theirRules);
  const changedIds = changedFieldIds(baseFields, fieldsResult.items);
  return {
    serverRevision,
    fields: fieldsResult.items,
    rules: rulesResult.items,
    conflicts: [...fieldsResult.conflicts, ...rulesResult.conflicts],
    changedFieldIds: changedIds,
  };
}

export function applyConflictChoices(merge: ProposedMerge): { fields: WorkField[]; rules: WorkRule[] } | null {
  if (merge.conflicts.some((conflict) => !conflict.choice)) return null;
  let fields = [...merge.fields];
  let rules = [...merge.rules];
  for (const conflict of merge.conflicts) {
    const chosen = conflict.choice === 'ours' ? conflict.ours : conflict.theirs;
    if (!chosen) {
      if (conflict.kind === 'field') fields = fields.filter((item) => item.id !== conflict.id);
      else rules = rules.filter((item) => item.id !== conflict.id);
      continue;
    }
    if (conflict.kind === 'field') {
      const index = fields.findIndex((item) => item.id === conflict.id);
      const field = { ...(chosen as WorkField) };
      if (index >= 0) fields[index] = field;
      else fields.push(field);
    } else {
      const index = rules.findIndex((item) => item.id === conflict.id);
      const rule = { ...(chosen as WorkRule) };
      if (index >= 0) rules[index] = rule;
      else rules.push(rule);
    }
  }
  return { fields, rules };
}

export function isDirtySession(session: {
  baseRevision: number;
  baseFields: WorkField[];
  baseRules: WorkRule[];
  fields: WorkField[];
  rules: WorkRule[];
}): boolean {
  return !sameItems(session.baseFields, session.fields) || !sameItems(session.baseRules, session.rules);
}
