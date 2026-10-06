import type { FormField, LinkRule } from './schemaLogic';
import type { FormVersion, Snapshot } from './store';

export interface SchemaLike {
  fields: FormField[];
  rules: LinkRule[];
}

export interface SchemaChange {
  id: string;
  kind: 'added' | 'removed' | 'changed';
  label: string;
  reasons: string[];
}

export interface SchemaDiff {
  fields: SchemaChange[];
  rules: SchemaChange[];
}

function optionList(field: FormField) {
  return field.type === 'select' ? (field.options ?? []).join('|') : '';
}

export function fieldChangeReasons(base: FormField, next: FormField): string[] {
  const reasons: string[] = [];
  if (base.label !== next.label) reasons.push(`名称：${base.label} → ${next.label}`);
  if (base.type !== next.type) reasons.push(`类型：${base.type} → ${next.type}`);
  if (base.required !== next.required) reasons.push(`必填：${base.required ? '是' : '否'} → ${next.required ? '是' : '否'}`);
  if (optionList(base) !== optionList(next)) reasons.push('选项集合发生变化');
  return reasons;
}

function ruleLabel(rule: LinkRule, fields: FormField[]) {
  const source = fields.find((field) => field.id === rule.fieldId)?.label ?? rule.fieldId;
  const target = fields.find((field) => field.id === rule.targetId)?.label ?? rule.targetId;
  return `${source} ${rule.operator === 'equals' ? `= ${rule.value}` : '非空'} → ${rule.effect === 'require' ? '必填' : '显示'} ${target}`;
}

function ruleKey(rule: LinkRule) {
  return JSON.stringify([rule.fieldId, rule.operator, rule.value, rule.effect, rule.targetId]);
}

function invalidRuleReasons(rule: LinkRule, fields: FormField[]) {
  const reasons: string[] = [];
  const source = fields.find((field) => field.id === rule.fieldId);
  const target = fields.find((field) => field.id === rule.targetId);
  if (!source) reasons.push(`源字段 ${rule.fieldId} 已被移除`);
  if (!target) reasons.push(`目标字段 ${rule.targetId} 已被移除`);
  if (source && rule.operator === 'equals' && source.type === 'select' && !(source.options ?? []).includes(rule.value)) {
    reasons.push(`选项“${rule.value}”已不存在`);
  }
  return reasons;
}

export function diffSchemas(base: SchemaLike, target: SchemaLike): SchemaDiff {
  const fields: SchemaChange[] = [];
  const baseFields = new Map(base.fields.map((field) => [field.id, field]));
  const targetFields = new Map(target.fields.map((field) => [field.id, field]));

  for (const field of target.fields) {
    const old = baseFields.get(field.id);
    if (!old) fields.push({ id: field.id, kind: 'added', label: field.label, reasons: ['新增字段'] });
    else {
      const reasons = fieldChangeReasons(old, field);
      if (reasons.length) fields.push({ id: field.id, kind: 'changed', label: field.label, reasons });
    }
  }
  for (const field of base.fields) {
    if (!targetFields.has(field.id)) fields.push({ id: field.id, kind: 'removed', label: field.label, reasons: ['字段已移除'] });
  }

  const rules: SchemaChange[] = [];
  const baseRules = new Map(base.rules.map((rule) => [rule.id, rule]));
  const targetRules = new Map(target.rules.map((rule) => [rule.id, rule]));
  for (const rule of target.rules) {
    const old = baseRules.get(rule.id);
    if (!old) rules.push({ id: rule.id, kind: 'added', label: ruleLabel(rule, target.fields), reasons: ['新增联动', ...invalidRuleReasons(rule, target.fields)] });
    else if (ruleKey(old) !== ruleKey(rule)) rules.push({ id: rule.id, kind: 'changed', label: ruleLabel(rule, target.fields), reasons: ['联动条件或效果发生变化', ...invalidRuleReasons(rule, target.fields)] });
  }
  for (const rule of base.rules) {
    if (!targetRules.has(rule.id)) rules.push({ id: rule.id, kind: 'removed', label: ruleLabel(rule, base.fields), reasons: ['联动已移除'] });
  }
  return { fields, rules };
}

export interface MigrationEntry {
  id: string;
  kind: 'unchanged' | 'changed' | 'removed' | 'added';
  sourceLabel?: string;
  targetLabel?: string;
  value?: string;
  reasons: string[];
}

export interface MigrationReport {
  entries: MigrationEntry[];
  migratedData: Record<string, string>;
  missingRequired: string[];
}

export function analyzeMigration(snapshot: Snapshot, source: FormVersion, target: SchemaLike): MigrationReport {
  const entries: MigrationEntry[] = [];
  const migratedData: Record<string, string> = {};
  const missingRequired: string[] = [];
  const sourceFields = new Map(source.fields.map((field) => [field.id, field]));
  const targetFields = new Map(target.fields.map((field) => [field.id, field]));

  for (const [id, value] of Object.entries(snapshot.data)) {
    const sourceField = sourceFields.get(id);
    const targetField = targetFields.get(id);
    migratedData[id] = value;
    if (!targetField) {
      entries.push({
        id,
        kind: 'removed',
        sourceLabel: sourceField?.label ?? id,
        value,
        reasons: ['字段已移除；值不会删除，仍按发布时版本读回并保留在迁移结果中'],
      });
      continue;
    }
    if (!sourceField) continue;
    const reasons = fieldChangeReasons(sourceField, targetField).map((reason) => `${reason}；旧值仍按 ${source.label} 的原含义读回`);
    if (targetField.type === 'select' && value && !targetField.options?.includes(value)) {
      reasons.push(`旧选项“${value}”不在新版选项中，需要人工确认映射`);
    }
    entries.push({
      id,
      kind: reasons.length ? 'changed' : 'unchanged',
      sourceLabel: sourceField.label,
      targetLabel: targetField.label,
      value,
      reasons,
    });
  }

  for (const field of target.fields) {
    if (!(field.id in migratedData)) migratedData[field.id] = '';
    if (!(field.id in snapshot.data)) {
      const reason = field.required ? '新版新增必填字段，旧数据没有值，迁移前需补充' : '新版新增选填字段，默认空值';
      entries.push({ id: field.id, kind: 'added', targetLabel: field.label, reasons: [reason] });
      if (field.required) missingRequired.push(field.label);
    }
  }

  return { entries, migratedData, missingRequired };
}

export function runtimeState(fields: FormField[], rules: LinkRule[], values: Record<string, string>) {
  const hidden = new Set<string>();
  const required = new Set(fields.filter((field) => field.required).map((field) => field.id));
  const fieldsById = new Map(fields.map((field) => [field.id, field]));

  for (const rule of rules) {
    const source = fieldsById.get(rule.fieldId);
    const target = fieldsById.get(rule.targetId);
    if (!source || !target) continue;
    const matched = rule.operator === 'equals'
      ? values[rule.fieldId] === rule.value
      : Boolean(values[rule.fieldId]);
    if (rule.effect === 'show' && !matched) hidden.add(rule.targetId);
    if (rule.effect === 'require' && matched) required.add(rule.targetId);
  }

  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (hidden.has(field.id)) continue;
    if (required.has(field.id) && !values[field.id]) errors[field.id] = `${field.label}为必填项`;
    if (field.type === 'number' && values[field.id] && Number.isNaN(Number(values[field.id]))) {
      errors[field.id] = `${field.label}必须是数字`;
    }
  }
  return { hidden, required, errors };
}
