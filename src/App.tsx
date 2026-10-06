import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Alert,
  AppBar,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Container,
  Divider,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Toolbar,
  Typography,
} from '@mui/material';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
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
  refreshSession,
  resolveConflicts,
  saveSession,
  selectSession,
  setRuntimeVersion,
  updateField,
  updateRule,
  type FormField,
  type FormVersion,
  type RootState,
  type WorkField,
  type WorkRule,
  type WorkSession,
} from './store';
import { analyzeMigration, diffSchemas, runtimeState, type SchemaLike } from './schemaView';
import { isDirtySession, type LinkRule, type MergeConflict } from './schemaLogic';

const fieldTypes: Array<{ value: FormField['type']; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'select', label: '单选' },
  { value: 'date', label: '日期' },
];

function describeField(field?: WorkField) {
  if (!field) return '（此侧已删除）';
  return `${field.label} / ${field.type} / ${field.required ? '必填' : '选填'}${field.options?.length ? ` / 选项：${field.options.join('、')}` : ''}`;
}

function describeRule(rule?: WorkRule, fields: WorkField[] = []) {
  if (!rule) return '（此侧已删除）';
  const source = fields.find((item) => item.id === rule.fieldId)?.label ?? rule.fieldId;
  const target = fields.find((item) => item.id === rule.targetId)?.label ?? rule.targetId;
  return `${source} ${rule.operator === 'equals' ? `等于 ${rule.value}` : '非空'} 时${rule.effect === 'require' ? '要求必填' : '显示'} ${target}`;
}

function statusColor(status?: WorkField['status']) {
  if (status === 'invalid') return 'error' as const;
  if (status === 'stale') return 'warning' as const;
  return 'success' as const;
}

function statusLabel(status?: WorkField['status']) {
  if (status === 'invalid') return '失效';
  if (status === 'stale') return '已重算待确认';
  return '有效';
}

function SortableFieldEditor({ field, disabled }: { field: WorkField; disabled: boolean }) {
  const dispatch = useDispatch();
  const sortable = useSortable({ id: field.id, disabled });

  return (
    <Card
      ref={sortable.setNodeRef}
      variant="outlined"
      sx={{ mb: 1.5, opacity: sortable.isDragging ? 0.6 : 1, transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
    >
      <CardContent sx={{ pb: '16px !important' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
          <Button size="small" disabled={disabled} {...sortable.attributes} {...sortable.listeners} sx={{ minWidth: 56 }}>拖拽</Button>
          <TextField
            size="small"
            label="字段名称"
            value={field.label}
            disabled={disabled}
            onChange={(event) => dispatch(updateField({ id: field.id, patch: { label: event.target.value } }))}
          />
          <FormControl size="small" sx={{ minWidth: 110 }}>
            <InputLabel>类型</InputLabel>
            <Select
              label="类型"
              value={field.type}
              disabled={disabled}
              onChange={(event) => dispatch(updateField({ id: field.id, patch: { type: event.target.value as FormField['type'] } }))}
            >
              {fieldTypes.map((type) => <MenuItem key={type.value} value={type.value}>{type.label}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControlLabel
            control={<Checkbox checked={field.required} disabled={disabled} onChange={(event) => dispatch(updateField({ id: field.id, patch: { required: event.target.checked } }))} />}
            label="必填"
          />
          <Button size="small" color="error" disabled={disabled} onClick={() => dispatch(deleteField(field.id))}>删除</Button>
        </Stack>
        {field.type === 'select' && (
          <TextField
            sx={{ mt: 2 }}
            fullWidth
            size="small"
            label="选项，用中文逗号或英文逗号分隔"
            value={field.options?.join('，') ?? ''}
            disabled={disabled}
            onChange={(event) => dispatch(updateField({
              id: field.id,
              patch: { options: event.target.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean) },
            }))}
          />
        )}
      </CardContent>
    </Card>
  );
}

function RuleEditor({ rule, fields, disabled }: { rule: WorkRule; fields: WorkField[]; disabled: boolean }) {
  const dispatch = useDispatch();
  const source = fields.find((field) => field.id === rule.fieldId);
  const targetOptions = fields.filter((field) => field.id !== rule.fieldId);

  return (
    <Alert severity={rule.status === 'invalid' ? 'error' : rule.status === 'stale' ? 'warning' : 'success'} sx={{ mb: 1.5, alignItems: 'center' }}>
      <Stack spacing={1.5} width="100%">
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Chip size="small" color={statusColor(rule.status)} label={statusLabel(rule.status)} />
          <Typography variant="body2">修订保存后会按字段最新定义重算；失效规则不能发布。</Typography>
        </Stack>
        {rule.reason && <Typography variant="body2" fontWeight={700}>原因：{rule.reason}</Typography>}
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <InputLabel>源字段</InputLabel>
            <Select label="源字段" value={rule.fieldId} disabled={disabled} onChange={(event) => dispatch(updateRule({ id: rule.id, patch: { fieldId: event.target.value } }))}>
              {fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel>条件</InputLabel>
            <Select label="条件" value={rule.operator} disabled={disabled} onChange={(event) => dispatch(updateRule({ id: rule.id, patch: { operator: event.target.value as LinkRule['operator'] } }))}>
              <MenuItem value="equals">等于</MenuItem>
              <MenuItem value="notEmpty">非空</MenuItem>
            </Select>
          </FormControl>
          {rule.operator === 'equals' && (
            source?.type === 'select' ? (
              <FormControl size="small" sx={{ minWidth: 140 }}>
                <InputLabel>值</InputLabel>
                <Select label="值" value={rule.value} disabled={disabled} onChange={(event) => dispatch(updateRule({ id: rule.id, patch: { value: event.target.value } }))}>
                  {(source.options ?? []).map((option) => <MenuItem key={option} value={option}>{option}</MenuItem>)}
                </Select>
              </FormControl>
            ) : (
              <TextField size="small" label="值" value={rule.value} disabled={disabled} onChange={(event) => dispatch(updateRule({ id: rule.id, patch: { value: event.target.value } }))} />
            )
          )}
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel>效果</InputLabel>
            <Select label="效果" value={rule.effect} disabled={disabled} onChange={(event) => dispatch(updateRule({ id: rule.id, patch: { effect: event.target.value as LinkRule['effect'] } }))}>
              <MenuItem value="show">显示</MenuItem>
              <MenuItem value="require">要求必填</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <InputLabel>目标字段</InputLabel>
            <Select label="目标字段" value={rule.targetId} disabled={disabled} onChange={(event) => dispatch(updateRule({ id: rule.id, patch: { targetId: event.target.value } }))}>
              {targetOptions.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
            </Select>
          </FormControl>
          <Button size="small" color="error" disabled={disabled} onClick={() => dispatch(deleteRule(rule.id))}>删除</Button>
        </Stack>
      </Stack>
    </Alert>
  );
}

function ConflictPanel({
  session,
  ourFields,
  ourRules,
  theirFields,
  theirRules,
}: {
  session: WorkSession;
  ourFields: WorkField[];
  ourRules: WorkRule[];
  theirFields: WorkField[];
  theirRules: WorkRule[];
}) {
  const dispatch = useDispatch();
  const merge = session.pendingMerge;
  if (!merge) return null;
  const unresolved = merge.conflicts.filter((conflict) => !conflict.choice).length;

  function conflictDescription(conflict: MergeConflict, side: 'ours' | 'theirs') {
    if (conflict.kind === 'field') return describeField(conflict[side] as WorkField | undefined);
    return describeRule(conflict[side] as WorkRule | undefined, side === 'ours' ? ourFields : theirFields);
  }

  return (
    <Alert severity="warning" variant="outlined" sx={{ mb: 3 }}>
      <Typography variant="h6" gutterBottom>检测到并发修改</Typography>
      <Typography variant="body2" mb={2}>
        本标签页基于 r{session.baseRevision} 打开，服务器已到 r{merge.serverRevision}。未冲突字段和联动已自动合并；同一项两边都修改时保留两份，逐项选择后才能保存。
      </Typography>
      <Stack spacing={2}>
        {merge.conflicts.map((conflict) => (
          <Card key={`${conflict.kind}-${conflict.id}`} variant="outlined">
            <CardContent>
              <Stack direction="row" spacing={1} alignItems="center" mb={1}>
                <Chip size="small" color={conflict.kind === 'field' ? 'primary' : 'secondary'} label={conflict.kind === 'field' ? '字段' : '联动'} />
                <Typography fontWeight={700}>{conflict.id}</Typography>
              </Stack>
              <Grid container spacing={2}>
                {(['ours', 'theirs'] as const).map((side) => (
                  <Grid size={{ xs: 12, md: 6 }} key={side}>
                    <Card variant={conflict.choice === side ? 'elevation' : 'outlined'} sx={{ p: 2, borderColor: conflict.choice === side ? 'primary.main' : undefined }}>
                      <Typography variant="body2" color="text.secondary" gutterBottom>{side === 'ours' ? '本标签页' : '对方/服务器'}</Typography>
                      <Typography sx={{ minHeight: 44 }}>{conflictDescription(conflict, side)}</Typography>
                      <Button
                        size="small"
                        variant={conflict.choice === side ? 'contained' : 'outlined'}
                        onClick={() => dispatch(chooseConflict({ id: conflict.id, kind: conflict.kind, choice: side }))}
                      >
                        {side === 'ours' ? '保留这一版' : '采用这一版'}
                      </Button>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            </CardContent>
          </Card>
        ))}
      </Stack>
      <Stack direction="row" spacing={2} mt={2}>
        <Button variant="contained" disabled={unresolved > 0} onClick={() => dispatch(resolveConflicts())}>
          {unresolved ? `还剩 ${unresolved} 项待选择` : '应用选择并保存'}
        </Button>
        <Button onClick={() => dispatch(cancelMerge())}>取消，保留本地改动</Button>
      </Stack>
    </Alert>
  );
}

function VersionPanel({ versions, draft }: { versions: FormVersion[]; draft: RootState['schema']['draft'] }) {
  const [sourceId, setSourceId] = useState(versions[0]?.id ?? '');
  const [targetId, setTargetId] = useState('draft');
  const source = versions.find((version) => version.id === sourceId) ?? versions[0];
  const target: SchemaLike = targetId === 'draft' ? draft : versions.find((version) => version.id === targetId) ?? draft;
  const diff = useMemo(() => source ? diffSchemas(source, target) : null, [source, target]);
  const invalidRules = draft.rules.filter((rule) => rule.status === 'invalid');
  const staleRules = draft.rules.filter((rule) => rule.status === 'stale');

  return (
    <Box mt={2}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} mb={2}>
        <FormControl size="small" fullWidth>
          <InputLabel>历史基线版本</InputLabel>
          <Select label="历史基线版本" value={source?.id ?? ''} onChange={(event) => setSourceId(event.target.value)}>
            {versions.map((version) => <MenuItem key={version.id} value={version.id}>{version.label} · {version.createdAt}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" fullWidth>
          <InputLabel>对比目标</InputLabel>
          <Select label="对比目标" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
            <MenuItem value="draft">当前草稿 r{draft.revision}</MenuItem>
            {versions.map((version) => <MenuItem key={version.id} value={version.id}>{version.label}</MenuItem>)}
          </Select>
        </FormControl>
      </Stack>

      {invalidRules.length > 0 && <Alert severity="error" sx={{ mb: 2 }}>有 {invalidRules.length} 条联动引用失效，发布被阻止。请先删除或修正。</Alert>}
      {staleRules.length > 0 && <Alert severity="warning" sx={{ mb: 2 }}>有 {staleRules.length} 条联动因字段变化已重新计算，请逐条确认原因后再发布。</Alert>}

      {draft.rules.filter((rule) => rule.status !== 'valid').map((rule) => (
        <Alert key={rule.id} severity={rule.status === 'invalid' ? 'error' : 'warning'} sx={{ mb: 1 }}>
          {describeRule(rule, draft.fields)}：{rule.reason}
        </Alert>
      ))}

      {diff && (
        <Grid container spacing={2} mt={1}>
          {(['fields', 'rules'] as const).map((section) => (
            <Grid size={{ xs: 12, md: 6 }} key={section}>
              <Typography fontWeight={700} mb={1}>{section === 'fields' ? '字段差异' : '联动差异'}</Typography>
              {!diff[section].length && <Alert severity="success">无差异</Alert>}
              {diff[section].map((item) => (
                <Alert key={`${section}-${item.kind}-${item.id}`} severity={item.kind === 'removed' ? 'error' : item.kind === 'changed' ? 'warning' : 'success'} sx={{ mb: 1 }}>
                  <Typography variant="body2" fontWeight={700}>{item.label}</Typography>
                  {item.reasons.map((reason) => <Typography key={reason} variant="caption" display="block">{reason}</Typography>)}
                </Alert>
              ))}
            </Grid>
          ))}
        </Grid>
      )}
      <Alert severity="info" sx={{ mt: 2 }}>发布后的版本不可变；之后即使字段含义或必填规则改变，旧提交仍按创建时的版本解释。被移除字段的值不会被物理删除。</Alert>
    </Box>
  );
}

function MigrationPanel({ versions, snapshots, draft }: { versions: FormVersion[]; snapshots: RootState['schema']['snapshots']; draft: RootState['schema']['draft'] }) {
  const [snapshotId, setSnapshotId] = useState(snapshots[0]?.id ?? '');
  const [targetId, setTargetId] = useState('draft');
  const snapshot = snapshots.find((item) => item.id === snapshotId) ?? snapshots[0];
  const source = versions.find((version) => version.id === snapshot?.versionId);
  const target: SchemaLike | undefined = targetId === 'draft' ? draft : versions.find((version) => version.id === targetId);
  const report = useMemo(() => snapshot && source && target ? analyzeMigration(snapshot, source, target) : null, [snapshot, source, target]);

  return (
    <Box mt={2}>
      <Stack spacing={2}>
        <FormControl size="small" fullWidth>
          <InputLabel>旧数据快照</InputLabel>
          <Select label="旧数据快照" value={snapshot?.id ?? ''} onChange={(event) => setSnapshotId(event.target.value)}>
            {snapshots.map((item) => <MenuItem key={item.id} value={item.id}>{item.label} · {versions.find((version) => version.id === item.versionId)?.label ?? item.versionId}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" fullWidth>
          <InputLabel>迁移目标</InputLabel>
          <Select label="迁移目标" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
            <MenuItem value="draft">当前草稿 r{draft.revision}</MenuItem>
            {versions.map((version) => <MenuItem key={version.id} value={version.id}>{version.label}</MenuItem>)}
          </Select>
        </FormControl>
      </Stack>

      {snapshot && source && (
        <Alert severity="info" sx={{ my: 2 }}>
          “{snapshot.label}”固定按 {source.label} 读回：{JSON.stringify(snapshot.data)}
        </Alert>
      )}

      {report && (
        <>
          <Alert severity={report.missingRequired.length ? 'warning' : 'success'} sx={{ mb: 2 }}>
            {report.missingRequired.length ? `迁移缺口：${report.missingRequired.join('、')} 是新版必填，需要补充。` : '没有必填迁移缺口。'}
          </Alert>
          {report.entries.map((entry) => (
            <Alert key={entry.id} severity={entry.kind === 'removed' ? 'info' : entry.kind === 'changed' ? 'warning' : entry.kind === 'added' ? 'success' : 'success'} sx={{ mb: 1 }}>
              <Typography variant="body2" fontWeight={700}>{entry.targetLabel ?? entry.sourceLabel}：{entry.kind === 'removed' ? '保留旧值' : entry.value || '空'}</Typography>
              {entry.reasons.map((reason) => <Typography key={reason} variant="caption" display="block">{reason}</Typography>)}
            </Alert>
          ))}
          <Card variant="outlined" sx={{ p: 2, mt: 2 }}>
            <Typography fontWeight={700} gutterBottom>兼容迁移包</Typography>
            <Typography variant="body2" style={{ wordBreak: 'break-all' }}>{JSON.stringify(report.migratedData)}</Typography>
            <Typography variant="caption" color="text.secondary">其中已移除字段仍在数据里，运行时按原版本解释，不会因新版结构而丢失。</Typography>
          </Card>
        </>
      )}
    </Box>
  );
}

function RuntimePanel({ version, dispatch }: { version: FormVersion; dispatch: ReturnType<typeof useDispatch> }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(version.fields.map((field) => [field.id, ''])));
  const [result, setResult] = useState<Record<string, string> | null>(null);
  const stateInfo = runtimeState(version.fields, version.rules, values);

  return (
    <Box mt={2}>
      <Stack spacing={2}>
        {version.fields.filter((field) => !stateInfo.hidden.has(field.id)).map((field) => (
          <TextField
            key={field.id}
            label={field.label}
            type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
            required={stateInfo.required.has(field.id)}
            value={values[field.id] ?? ''}
            error={Boolean(stateInfo.errors[field.id])}
            helperText={stateInfo.errors[field.id] ?? (stateInfo.required.has(field.id) && !field.required ? '由当前联动规则临时要求必填' : ' ')}
            InputLabelProps={field.type === 'date' ? { shrink: true } : undefined}
            select={field.type === 'select'}
            onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
          >
            {field.type === 'select' && (field.options ?? []).map((option) => <MenuItem key={option} value={option}>{option}</MenuItem>)}
          </TextField>
        ))}
        <Button
          variant="contained"
          onClick={() => {
            if (Object.keys(stateInfo.errors).length) return;
            const submitted = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
            dispatch(addSnapshot({ versionId: version.id, label: `${version.label} 运行态提交`, data: submitted }));
            setResult(submitted);
          }}
        >
          按 {version.label} 提交
        </Button>
        {Object.keys(stateInfo.errors).length > 0 && <Alert severity="error">请先修正：{Object.values(stateInfo.errors).join('；')}</Alert>}
        {result && <Alert severity="success">已保存快照，并永久绑定到 {version.label}：{JSON.stringify(result)}</Alert>}
        <Alert severity="info">动态联动只解释当前发布版本；以后字段改名、改类型或变成必填，都不会回溯改变这份提交。</Alert>
      </Stack>
    </Box>
  );
}

export default function App() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const session = state.sessions[state.selectedSessionId];
  const dirty = isDirtySession(session);
  const [tab, setTab] = useState(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const runtimeVersion = state.versions.find((version) => version.id === state.runtimeVersionId) ?? state.versions[state.versions.length - 1];
  const blocked = Boolean(session.pendingMerge) || dirty || state.draft.rules.some((rule) => rule.status === 'invalid');

  function dragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      dispatch(reorderFields({ activeId: String(event.active.id), overId: String(event.over.id) }));
    }
  }

  function addDefaultRule() {
    const source = session.fields[0];
    const target = session.fields[1];
    if (!source || !target) return;
    dispatch(addRule({
      fieldId: source.id,
      operator: 'equals',
      value: source.options?.[0] ?? '',
      effect: 'require',
      targetId: target.id,
    }));
  }

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky"><Toolbar><Typography variant="h6" flexGrow={1}>{t('title')}</Typography><Button color="inherit" disabled={blocked} onClick={() => dispatch(publishDraft())}>{t('publish')} r{state.draft.revision}</Button></Toolbar></AppBar>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Grid container spacing={2} alignItems="center">
              <Grid size={{ xs: 12, md: 4 }}>
                <FormControl fullWidth size="small">
                  <InputLabel>编辑标签页</InputLabel>
                  <Select label="编辑标签页" value={state.selectedSessionId} onChange={(event) => dispatch(selectSession(event.target.value))}>
                    {Object.values(state.sessions).map((item) => <MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>)}
                  </Select>
                </FormControl>
              </Grid>
              <Grid size={{ xs: 12, md: 5 }}>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Chip color="info" label={`打开基准 r${session.baseRevision}`} />
                  <Chip color="secondary" label={`服务器 r${state.draft.revision}`} />
                  <Chip color={dirty ? 'warning' : 'success'} label={dirty ? '有本地改动' : '已同步'} />
                  {session.pendingMerge && <Chip color="error" label="冲突待选择" />}
                </Stack>
              </Grid>
              <Grid size={{ xs: 12, md: 3 }}>
                <Stack direction="row" spacing={1}>
                  <Button size="small" variant="contained" disabled={Boolean(session.pendingMerge)} onClick={() => dispatch(saveSession())}>保存</Button>
                  <Button size="small" disabled={dirty || Boolean(session.pendingMerge)} onClick={() => dispatch(refreshSession())}>重新拉取</Button>
                </Stack>
              </Grid>
            </Grid>
            {session.message && <Alert severity={session.pendingMerge ? 'warning' : dirty ? 'info' : 'success'} sx={{ mt: 2 }}>{session.message}</Alert>}
            <Typography variant="caption" color="text.secondary" display="block" mt={1}>
              可直接切换 A/B 在同页模拟两个标签页；也可打开两个真实浏览器标签页，分别选择 A/B，保存会通过 localStorage 事件同步服务端修订。
            </Typography>
          </CardContent>
        </Card>

        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card>
              <CardContent>
                <ConflictPanel
                  session={session}
                  ourFields={session.fields}
                  ourRules={session.rules}
                  theirFields={state.draft.fields}
                  theirRules={state.draft.rules}
                />
                <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
                  <div>
                    <Typography variant="h6">字段编排</Typography>
                    <Typography variant="body2" color="text.secondary">保存时携带打开时修订号；字段一改，引用它的联动立刻标记并重算原因。</Typography>
                  </div>
                  <Button variant="contained" disabled={Boolean(session.pendingMerge)} onClick={() => dispatch(addField())}>添加字段</Button>
                </Stack>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
                  <SortableContext items={session.fields.map((field) => field.id)} strategy={verticalListSortingStrategy}>
                    {session.fields.map((field) => <SortableFieldEditor key={field.id} field={field} disabled={Boolean(session.pendingMerge)} />)}
                  </SortableContext>
                </DndContext>

                <Divider sx={{ my: 3 }} />
                <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
                  <div>
                    <Typography variant="h6">联动规则</Typography>
                    <Typography variant="body2" color="text.secondary">引用字段删除或选项消失会失效；字段修改会要求发布前确认。</Typography>
                  </div>
                  <Stack direction="row" spacing={1}>
                    <Button
                      size="small"
                      color="warning"
                      disabled={Boolean(session.pendingMerge) || !session.rules.some((rule) => rule.status === 'stale')}
                      onClick={() => dispatch(acknowledgeStaleRules())}
                    >
                      确认重算结果
                    </Button>
                    <Button variant="outlined" disabled={Boolean(session.pendingMerge) || session.fields.length < 2} onClick={addDefaultRule}>添加联动</Button>
                  </Stack>
                </Stack>
                {!session.rules.length && <Alert severity="info">暂无联动规则</Alert>}
                {session.rules.map((rule) => <RuleEditor key={rule.id} rule={rule} fields={session.fields} disabled={Boolean(session.pendingMerge)} />)}
              </CardContent>
            </Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <CardContent>
                <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable">
                  <Tab label="版本差异" />
                  <Tab label={t('simulate')} />
                  <Tab label={t('runtime')} />
                </Tabs>
                {tab === 0 && <VersionPanel versions={state.versions} draft={state.draft} />}
                {tab === 1 && <MigrationPanel versions={state.versions} snapshots={state.snapshots} draft={state.draft} />}
                {tab === 2 && (
                  <Box mt={2}>
                    <FormControl size="small" fullWidth sx={{ mb: 2 }}>
                      <InputLabel>运行版本</InputLabel>
                      <Select label="运行版本" value={runtimeVersion.id} onChange={(event) => dispatch(setRuntimeVersion(event.target.value))}>
                        {state.versions.map((version) => <MenuItem key={version.id} value={version.id}>{version.label} · {version.createdAt}</MenuItem>)}
                      </Select>
                    </FormControl>
                    <RuntimePanel key={runtimeVersion.id} version={runtimeVersion} dispatch={dispatch} />
                  </Box>
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}
