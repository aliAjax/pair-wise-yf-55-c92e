import type { ConflictItem, FormField, FormVersion, LinkRule, Snapshot } from './store';

/** 深比较（基于 JSON 序列化，字段/规则都是纯数据） */
export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 字段或规则的联合类型，用于三方合并 */
type Item = FormField | LinkRule;

function itemLabel(item: Item | null | undefined): string {
  if (!item) return '';
  return 'label' in item ? item.label : item.id;
}

/**
 * 三方合并：以 base（打开时的快照）为基准，合并 ours（当前标签页）与 theirs（对方已保存的最新版）。
 * 逐条字段/规则判断：
 * - 两边都没动 → 保留
 * - 只有一边动 → 照动的那边走
 * - 两边改得一样 → 保留
 * - 两边改得不一样 → 记冲突，两份都留下等人挑
 * - 一边删、一边改 → 记冲突（删除 vs 修改）
 */
export function threeWayMerge<T extends Item>(
  baseItems: T[],
  oursItems: T[],
  theirsItems: T[],
  kind: 'field' | 'rule'
): { items: T[]; conflicts: ConflictItem[] } {
  const baseMap = new Map(baseItems.map((i) => [i.id, i]));
  const oursMap = new Map(oursItems.map((i) => [i.id, i]));
  const theirsMap = new Map(theirsItems.map((i) => [i.id, i]));
  const ids = new Set<string>([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
  const items: T[] = [];
  const conflicts: ConflictItem[] = [];

  for (const id of ids) {
    const b = baseMap.get(id);
    const o = oursMap.get(id);
    const t = theirsMap.get(id);
    const conflictId = `conf-${kind}-${id}-${Math.random().toString(36).slice(2, 8)}`;

    // 两边都删了
    if (!o && !t) continue;

    // 我方删除，对方保留/修改
    if (!o && t) {
      if (b && !deepEqual(t, b)) {
        conflicts.push({
          id: conflictId, kind, itemId: id, ours: null, theirs: t,
          reason: `${kind === 'field' ? '字段' : '联动规则'}「${itemLabel(t)}」我方已删除、对方有修改`
        });
      }
      items.push(t);
      continue;
    }

    // 对方删除，我方保留/修改
    if (o && !t) {
      if (b && !deepEqual(o, b)) {
        conflicts.push({
          id: conflictId, kind, itemId: id, ours: o, theirs: null,
          reason: `${kind === 'field' ? '字段' : '联动规则'}「${itemLabel(o)}」对方已删除、我方有修改`
        });
      }
      items.push(o);
      continue;
    }

    // 两边都有
    if (deepEqual(o, t)) { items.push(o!); continue; }
    if (deepEqual(o, b)) { items.push(t!); continue; } // 我方没动，照对方
    if (deepEqual(t, b)) { items.push(o!); continue; } // 对方没动，照我方

    // 两边改得不一样 → 两份都留下，记冲突
    conflicts.push({
      id: conflictId, kind, itemId: id, ours: o!, theirs: t!,
      reason: `${kind === 'field' ? '字段' : '联动规则'}「${itemLabel(o)}」两边都做了不同修改`
    });
    items.push(o!);
  }

  return { items, conflicts };
}

/**
 * 规则失效重算：字段一改动，引用它的联动就重新校验。
 * - 来源/目标字段被删 → 失效
 * - 来源字段选项变更，条件值不再是有效选项 → 失效
 * - 其余情况重算后仍然有效（标签改动、类型微调等不影响引用）
 */
export function validateRules(fields: FormField[], rules: LinkRule[]): LinkRule[] {
  return rules.map((rule) => {
    const source = fields.find((f) => f.id === rule.fieldId);
    const target = fields.find((f) => f.id === rule.targetId);
    const reasons: string[] = [];
    if (!source) reasons.push(`来源字段「${rule.fieldId}」已被删除`);
    if (!target) reasons.push(`目标字段「${rule.targetId}」已被删除`);
    if (
      source &&
      rule.operator === 'equals' &&
      source.type === 'select' &&
      source.options &&
      !source.options.includes(rule.value)
    ) {
      reasons.push(`来源字段选项已变更，条件值「${rule.value}」不再是有效选项`);
    }
    return { ...rule, invalid: reasons.length > 0, reason: reasons.join('；') };
  });
}

export interface MigrationReport {
  /** 新版必填但旧数据缺失，需要补充 */
  gaps: string[];
  /** 新版已移除的字段，旧值保留不丢 */
  removed: string[];
  /** 字段含义/类型变更，旧值按原版解释后迁移 */
  changed: string[];
  canMigrate: boolean;
}

/**
 * 旧数据迁移兼容：
 * - 已发布版本按当时那版解释（用快照所属版本的字段定义读回旧值）
 * - 字段被移除 → 旧值保留，不丢弃
 * - 字段类型/含义变更 → 旧值按原版解释后迁移
 * - 必填变更（选填→必填）且旧数据缺失 → 缺口
 * - 新版必填字段在旧数据中不存在 → 缺口
 */
export function simulateMigration(
  snapshot: Snapshot,
  fromVersion: FormVersion | undefined,
  toFields: FormField[]
): MigrationReport {
  const gaps: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const oldFields = fromVersion?.fields ?? [];

  for (const oldField of oldFields) {
    const value = snapshot.data[oldField.id];
    const newField = toFields.find((f) => f.id === oldField.id);
    if (!newField) {
      if (value !== undefined && value !== '') {
        removed.push(`字段「${oldField.label}」已在新版移除，旧值「${value}」保留不丢`);
      }
      continue;
    }
    if (newField.type !== oldField.type) {
      changed.push(`字段「${oldField.label}」类型由 ${oldField.type} 变为 ${newField.type}，旧值按原版解释后迁移`);
    }
    if (!oldField.required && newField.required && !value) {
      gaps.push(`字段「${oldField.label}」由选填改为必填，旧数据缺失需补充`);
    }
  }

  for (const newField of toFields) {
    if (newField.required && !snapshot.data[newField.id]) {
      const existed = oldFields.some((f) => f.id === newField.id);
      if (!existed) {
        gaps.push(`新版必填字段「${newField.label}」在旧数据中不存在，需补充或给默认值`);
      }
    }
  }

  return { gaps, removed, changed, canMigrate: gaps.length === 0 };
}
