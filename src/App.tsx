import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Alert, AppBar, Box, Button, Card, CardContent, Chip, Container, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, FormControl, FormControlLabel, Grid, InputLabel,
  MenuItem, Select, Stack, Switch, Tab, Tabs, TextField, Toolbar, Typography
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  addField, addRule as addRuleAction, dismissPublishBlock, publishVersion, reorderFields, reloadFromRemote,
  removeField, removeRule, resolveConflict, saveDraft, selectPreview, simulateConcurrentEdit,
  simulateMigrationReport, updateField, useSchemaHistoryQuery,
  type ConflictItem, type FieldType, type FormField, type LinkRule, type RootState
} from './store';

const FIELD_TYPES: FieldType[] = ['text', 'number', 'select', 'date'];

function describeField(field: FormField | null): string {
  if (!field) return '（已删除）';
  return `${field.label}（${field.type}${field.required ? '，必填' : '，选填'}）`;
}

function describeRule(rule: LinkRule | null, fields: FormField[]): string {
  if (!rule) return '（已删除）';
  const source = fields.find((f) => f.id === rule.fieldId)?.label ?? rule.fieldId;
  const target = fields.find((f) => f.id === rule.targetId)?.label ?? rule.targetId;
  return `${source} ${rule.operator === 'equals' ? '等于' : '非空'} ${rule.value || '∅'} → ${rule.effect === 'require' ? '要求' : '显示'} ${target}`;
}

function SortableField({ field, onEdit, onRemove }: { field: FormField; onEdit: () => void; onRemove: () => void }) {
  const sortable = useSortable({ id: field.id });
  return (
    <Card ref={sortable.setNodeRef} variant="outlined" sx={{ mb: 1, ...(sortable.isDragging ? { opacity: 0.6 } : {}) }}>
      <CardContent sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: '12px !important' }}>
        <Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography fontWeight={700}>{field.label}</Typography>
            {field.required && <Chip label="必填" size="small" color="error" variant="outlined" />}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {field.type}{field.options?.length ? ` · 选项：${field.options.join('、')}` : ''}
          </Typography>
        </Box>
        <Stack direction="row" spacing={0.5}>
          <Button size="small" onClick={onEdit}>编辑</Button>
          <Button size="small" color="error" onClick={onRemove}>删除</Button>
          <Button size="small" {...sortable.attributes} {...sortable.listeners}>拖拽</Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

function ConflictCard({ conflict, fields, onResolve }: {
  conflict: ConflictItem;
  fields: FormField[];
  onResolve: (choice: 'ours' | 'theirs') => void;
}) {
  const isField = conflict.kind === 'field';
  return (
    <Alert severity="warning" sx={{ mb: 1 }}>
      <Typography variant="body2" fontWeight={700}>{conflict.reason}</Typography>
      <Stack direction="row" spacing={2} mt={1} flexWrap="wrap">
        <Box flex={1} minWidth={200}>
          <Typography variant="caption" color="text.secondary">我方（当前标签页）</Typography>
          <Typography variant="body2">{isField ? describeField(conflict.ours as FormField | null) : describeRule(conflict.ours as LinkRule | null, fields)}</Typography>
        </Box>
        <Box flex={1} minWidth={200}>
          <Typography variant="caption" color="text.secondary">对方（已保存）</Typography>
          <Typography variant="body2">{isField ? describeField(conflict.theirs as FormField | null) : describeRule(conflict.theirs as LinkRule | null, fields)}</Typography>
        </Box>
      </Stack>
      <Stack direction="row" spacing={1} mt={1}>
        <Button size="small" variant="outlined" onClick={() => onResolve('ours')}>采用我方</Button>
        <Button size="small" variant="contained" onClick={() => onResolve('theirs')}>采用对方</Button>
      </Stack>
    </Alert>
  );
}

export default function App() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const { draft, versions, snapshots, conflicts, dirty, baseRevision, remoteRevision, publishBlocked } = state;
  const previewVersion = versions.find((item) => item.id === state.previewVersionId) ?? versions[0];
  const [tab, setTab] = useState(0);
  const [migrationId, setMigrationId] = useState<string | null>(null);
  const [runtimeValues, setRuntimeValues] = useState<Record<string, string>>({});
  const [runtimeResult, setRuntimeResult] = useState<Record<string, unknown> | null>(null);

  const [editTarget, setEditTarget] = useState<FormField | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editType, setEditType] = useState<FieldType>('text');
  const [editRequired, setEditRequired] = useState(false);
  const [editOptions, setEditOptions] = useState('');

  const [ruleSource, setRuleSource] = useState('');
  const [ruleOperator, setRuleOperator] = useState<'equals' | 'notEmpty'>('equals');
  const [ruleValue, setRuleValue] = useState('');
  const [ruleEffect, setRuleEffect] = useState<'show' | 'require'>('require');
  const [ruleTarget, setRuleTarget] = useState('');

  const baseRevisionRef = useRef(baseRevision);
  useEffect(() => { baseRevisionRef.current = baseRevision; }, [baseRevision]);
  const sensors = useSensors(useSensor(PointerSensor));

  const { data: history = [] } = useSchemaHistoryQuery(previewVersion.id);

  function openEdit(field: FormField) {
    setEditTarget(field);
    setEditLabel(field.label);
    setEditType(field.type);
    setEditRequired(field.required);
    setEditOptions(field.options?.join(', ') ?? '');
  }
  function saveEdit() {
    if (!editTarget) return;
    const options = editType === 'select'
      ? editOptions.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      : undefined;
    dispatch(updateField({ id: editTarget.id, changes: { label: editLabel.trim() || editTarget.label, type: editType, required: editRequired, options } }));
    setEditTarget(null);
  }

  function handleAddRule() {
    if (!ruleSource || !ruleTarget) return;
    dispatch(addRuleAction({ fieldId: ruleSource, operator: ruleOperator, value: ruleValue, effect: ruleEffect, targetId: ruleTarget }));
    setRuleValue('');
  }

  function dragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      dispatch(reorderFields({ activeId: String(event.active.id), overId: String(event.over.id) }));
    }
  }

  const migrationReport = migrationId ? simulateMigrationReport(state, migrationId) : null;
  const invalidRules = draft.rules.filter((r) => r.invalid);

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary">
        <Toolbar>
          <Typography variant="h6" flexGrow={1}>{t('title')}</Typography>
          <Chip label={`修订号 ${draft.revision}`} size="small" sx={{ mr: 1, color: '#fff', borderColor: '#fff' }} variant="outlined" />
          {dirty && <Chip label="有未保存改动" size="small" color="warning" sx={{ mr: 1 }} />}
          <Button color="inherit" onClick={() => dispatch(simulateConcurrentEdit())}>模拟他标签页并发</Button>
          <Button color="inherit" onClick={() => dispatch(saveDraft())}>保存草稿</Button>
          <Button color="inherit" onClick={() => dispatch(publishVersion())}>{t('publish')}</Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        {remoteRevision !== null && (
          <Alert severity="warning" sx={{ mb: 2 }} action={
            <Stack direction="row" spacing={1}>
              <Button color="inherit" size="small" onClick={() => dispatch(reloadFromRemote())}>重新加载</Button>
              <Button color="inherit" size="small" onClick={() => dispatch(saveDraft())}>保存并合并</Button>
            </Stack>
          }>
            其他标签页已保存到修订号 {remoteRevision}，当前草稿基于修订号 {baseRevision}。后保存不会覆盖对方成果，将逐条合并。
          </Alert>
        )}

        {conflicts.length > 0 && (
          <Card sx={{ mb: 2, borderColor: 'warning.main' }}>
            <CardContent>
              <Typography variant="h6" color="warning.main" gutterBottom>合并冲突（{conflicts.length}）</Typography>
              <Typography variant="body2" color="text.secondary" mb={1}>同一个字段或联动两边都改过，两份都留下了，请挑一份。</Typography>
              {conflicts.map((conflict) => (
                <ConflictCard key={conflict.id} conflict={conflict} fields={draft.fields} onResolve={(choice) => dispatch(resolveConflict({ id: conflict.id, choice }))} />
              ))}
            </CardContent>
          </Card>
        )}

        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card><CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
                <div>
                  <Typography variant="h6">字段编排</Typography>
                  <Typography variant="body2" color="text.secondary">拖动排序、编辑或删除字段；保存时带修订号，冲突逐条合并。</Typography>
                </div>
                <Button variant="contained" onClick={() => dispatch(addField())}>添加字段</Button>
              </Stack>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
                <SortableContext items={draft.fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                  <Stack>{draft.fields.map((field) => (
                    <SortableField key={field.id} field={field} onEdit={() => openEdit(field)} onRemove={() => dispatch(removeField(field.id))} />
                  ))}</Stack>
                </SortableContext>
              </DndContext>

              <Divider sx={{ my: 3 }} />
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                <Typography variant="h6">联动规则</Typography>
                {invalidRules.length > 0 && <Chip label={`${invalidRules.length} 条失效`} color="error" size="small" />}
              </Stack>
              {draft.rules.length === 0 && <Typography variant="body2" color="text.secondary">暂无联动规则。</Typography>}
              {draft.rules.map((rule) => (
                <Alert key={rule.id} severity={rule.invalid ? 'error' : 'info'} sx={{ mb: 1 }}
                  action={<Button size="small" color="inherit" onClick={() => dispatch(removeRule(rule.id))}>删除</Button>}>
                  <Typography variant="body2">{describeRule(rule, draft.fields)}</Typography>
                  {rule.invalid && <Typography variant="caption" color="error">失效原因：{rule.reason}</Typography>}
                </Alert>
              ))}
              <Stack direction="row" spacing={1} mt={2} flexWrap="wrap" useFlexGap>
                <FormControl size="small" sx={{ minWidth: 120 }}>
                  <InputLabel>来源字段</InputLabel>
                  <Select label="来源字段" value={ruleSource} onChange={(e) => setRuleSource(e.target.value)}>
                    {draft.fields.map((f) => <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>)}
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ minWidth: 110 }}>
                  <InputLabel>条件</InputLabel>
                  <Select label="条件" value={ruleOperator} onChange={(e) => setRuleOperator(e.target.value as 'equals' | 'notEmpty')}>
                    <MenuItem value="equals">等于</MenuItem>
                    <MenuItem value="notEmpty">非空</MenuItem>
                  </Select>
                </FormControl>
                {ruleOperator === 'equals' && <TextField size="small" label="值" value={ruleValue} onChange={(e) => setRuleValue(e.target.value)} sx={{ width: 100 }} />}
                <FormControl size="small" sx={{ minWidth: 110 }}>
                  <InputLabel>效果</InputLabel>
                  <Select label="效果" value={ruleEffect} onChange={(e) => setRuleEffect(e.target.value as 'show' | 'require')}>
                    <MenuItem value="require">要求</MenuItem>
                    <MenuItem value="show">显示</MenuItem>
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ minWidth: 120 }}>
                  <InputLabel>目标字段</InputLabel>
                  <Select label="目标字段" value={ruleTarget} onChange={(e) => setRuleTarget(e.target.value)}>
                    {draft.fields.map((f) => <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>)}
                  </Select>
                </FormControl>
                <Button variant="outlined" onClick={handleAddRule}>添加联动</Button>
              </Stack>
            </CardContent></Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card><CardContent>
              <Tabs value={tab} onChange={(_, value) => setTab(value)}>
                <Tab label="版本差异" />
                <Tab label={t('simulate')} />
                <Tab label={t('runtime')} />
              </Tabs>

              {tab === 0 && (
                <Box mt={2}>
                  <Typography fontWeight={700} mb={1}>v1 → {previewVersion.label}</Typography>
                  <Stack direction="row" gap={1} flexWrap="wrap">
                    {previewVersion.fields.map((field) => <Chip key={field.id} label={`${field.label}（${field.type}）`} color="success" variant="outlined" />)}
                  </Stack>
                  <Alert severity="warning" sx={{ mt: 2 }}>旧版本解释保持冻结；过去提交的数据按当时那版解释，不随字段新增而改变。</Alert>
                  <Typography mt={2} fontWeight={700}>其他历史版本</Typography>
                  {history.map((version) => (
                    <Button key={version.id} fullWidth sx={{ justifyContent: 'space-between' }} onClick={() => dispatch(selectPreview(version.id))}>
                      {version.label}<span>{version.createdAt}</span>
                    </Button>
                  ))}
                </Box>
              )}

              {tab === 1 && (
                <Box mt={2}>
                  <Typography fontWeight={700} mb={1}>选择旧数据快照（按所属版本解释）</Typography>
                  {snapshots.map((snapshot) => {
                    const fromVersion = versions.find((v) => v.id === snapshot.versionId);
                    return (
                      <Card key={snapshot.id} variant="outlined" sx={{ p: 2, mb: 1 }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center">
                          <Box>
                            <Typography>{snapshot.label}</Typography>
                            <Typography variant="caption" color="text.secondary">按 {fromVersion?.label ?? snapshot.versionId} 解释</Typography>
                          </Box>
                          <Button size="small" onClick={() => setMigrationId(snapshot.id)}>模拟迁移到当前草稿</Button>
                        </Stack>
                        <Typography variant="body2" color="text.secondary" mt={1}>{JSON.stringify(snapshot.data)}</Typography>
                      </Card>
                    );
                  })}
                  {migrationReport && (
                    <Stack spacing={1} mt={2}>
                      {migrationReport.gaps.map((g, i) => <Alert key={`g-${i}`} severity="warning">{g}</Alert>)}
                      {migrationReport.removed.map((r, i) => <Alert key={`r-${i}`} severity="info">{r}</Alert>)}
                      {migrationReport.changed.map((c, i) => <Alert key={`c-${i}`} severity="info">{c}</Alert>)}
                      {migrationReport.canMigrate && migrationReport.gaps.length === 0 && migrationReport.removed.length === 0 && migrationReport.changed.length === 0 && (
                        <Alert severity="success">旧数据可以直接迁移到当前版本。</Alert>
                      )}
                      {!migrationReport.canMigrate && <Alert severity="error">存在必填缺口，需补充或给默认值后才能迁移。</Alert>}
                    </Stack>
                  )}
                </Box>
              )}

              {tab === 2 && (
                <Box component="form" mt={2} onSubmit={(e) => { e.preventDefault(); setRuntimeResult(runtimeValues); }}>
                  <Stack spacing={2}>
                    {draft.fields.map((field) => (
                      <TextField key={field.id} label={field.label} select={field.type === 'select'}
                        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                        required={field.required} value={runtimeValues[field.id] ?? ''}
                        onChange={(e) => setRuntimeValues((prev) => ({ ...prev, [field.id]: e.target.value }))}>
                        {field.type === 'select' && field.options?.map((opt) => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                      </TextField>
                    ))}
                    <Button type="submit" variant="contained">按当前版本提交</Button>
                  </Stack>
                  {runtimeResult && <Alert severity="success" sx={{ mt: 2 }}>运行态数据：{JSON.stringify(runtimeResult)}</Alert>}
                  <Alert severity="info" sx={{ mt: 2 }}>历史数据按创建时版本解释，不随字段新增而改变。</Alert>
                </Box>
              )}
            </CardContent></Card>
          </Grid>
        </Grid>
      </Container>

      <Dialog open={Boolean(editTarget)} onClose={() => setEditTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>编辑字段</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="字段名称" value={editLabel} onChange={(e) => setEditLabel(e.target.value)} fullWidth />
            <FormControl fullWidth>
              <InputLabel>字段类型</InputLabel>
              <Select label="字段类型" value={editType} onChange={(e) => setEditType(e.target.value as FieldType)}>
                {FIELD_TYPES.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControlLabel control={<Switch checked={editRequired} onChange={(e) => setEditRequired(e.target.checked)} />} label="必填" />
            {editType === 'select' && (
              <TextField label="选项（逗号分隔）" value={editOptions} onChange={(e) => setEditOptions(e.target.value)} fullWidth helperText="改动选项会让引用旧值的联动失效重算" />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditTarget(null)}>取消</Button>
          <Button variant="contained" onClick={saveEdit}>保存</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={publishBlocked !== null} onClose={() => dispatch(dismissPublishBlock())} maxWidth="sm" fullWidth>
        <DialogTitle>发布被拦下：有失效规则</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" mb={2}>字段改动后引用它的联动已失效，请删除或修复后再发布。</Typography>
          {publishBlocked?.map((reason, i) => <Alert key={i} severity="error" sx={{ mb: 1 }}>{reason}</Alert>)}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => dispatch(dismissPublishBlock())}>知道了</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
