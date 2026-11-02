'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApiResponseError, readApiResponse } from '@/client/api';
import { AdminGuard } from './providers';
import styles from './admin-view.module.css';
import {
  baseModelApiKeyEnv,
  modelCapabilityLabels,
  modelProviderChoiceOptionKeys,
  modelProviderOptionChoices,
  modelProviderOptionLabels,
  modelProviderOptionKeys,
  modelProviderFormatViews,
  providerHeaderLimit,
  providerHeaderNameSchema,
  providerHeaderValueSchema,
  providerOptionKeysByFormat,
  providerOptionsSchema,
  providerModelListLimit,
  providerModelsViewSchema,
  reasoningLevelLabels,
  reasoningLevels,
  type ModelAliasSettings,
  type ModelConfigVersion,
  type ModelProviderOptions,
  type ModelProviderWriteInput,
  type ModelSlotView,
  type ProviderApiFormat,
  type ProviderKeySource,
  type ProviderModelsView,
  type ReasoningLevel,
} from '@/shared/model-config';
import {
  currentPriceOf,
  fenToYuan,
  formatCny,
  formatUsd,
  modelAdminConfigViewSchema,
  modelConfigVersionViewSchema,
  modelEligibilityIssue,
  yuanToFen,
  type ModelAdminConfigView,
  type ModelAdminModelView,
  type ModelAdminProviderView,
  type ModelAssignmentView,
  type ModelPriceVersion,
} from '@/shared/model-document';

type AdminOutcome<T> = { ok: true; data: T } | { ok: false; status: number; code: number; message: string };
type ProviderHeaderRow = { name: string; value: string };

type ProviderFormValues = {
  id: string;
  displayName: string;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  apiKeySource: ProviderKeySource;
  apiKeyEnv: string;
  apiKey: string;
  options: ModelProviderOptions;
  requestHeaders: ProviderHeaderRow[];
  enabled: boolean;
};

type AddModelFormValues = {
  upstream: string;
  displayName: string;
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    structuredOutput: boolean;
    imageInput: boolean;
  };
  enabled: boolean;
  inputMissYuan?: number | null;
  inputHitYuan?: number | null;
  outputYuan?: number | null;
};

type PriceFormValues = {
  displayName: string;
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    structuredOutput: boolean;
    imageInput: boolean;
  };
  enabled: boolean;
  inputMissYuan?: number | null;
  inputHitYuan?: number | null;
  outputYuan?: number | null;
  note?: string;
};

type SlotFormValues = {
  modelId: string;
  settings: {
    temperature?: number | null;
    topP?: number | null;
    maxOutputTokens?: number | null;
    reasoning?: ReasoningLevel | null;
    reasoningContentPassthrough?: boolean;
  };
};

const emptyCapabilities = { streaming: false, toolCalling: false, structuredOutput: false, imageInput: false };

export function ModelManager() {
  return (
    <AdminGuard>
      <ModelConfigManager />
    </AdminGuard>
  );
}

function ModelConfigManager() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<ModelAdminConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [providerEditor, setProviderEditor] = useState<{ mode: 'create' } | { mode: 'edit'; original: ModelAdminProviderView } | null>(null);
  const [addModelFor, setAddModelFor] = useState<ModelAdminProviderView | null>(null);
  const [modelEditor, setModelEditor] = useState<ModelAdminModelView | null>(null);
  const [slotEditor, setSlotEditor] = useState<{ slot: ModelSlotView; assignment: ModelAssignmentView | null } | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeText, setProbeText] = useState<string | null>(null);
  const [upstreamModels, setUpstreamModels] = useState<ProviderModelsView['models']>([]);
  const [providerForm] = Form.useForm<ProviderFormValues>();
  const [addModelForm] = Form.useForm<AddModelFormValues>();
  const [priceForm] = Form.useForm<PriceFormValues>();
  const [slotForm] = Form.useForm<SlotFormValues>();

  const reload = useCallback(async () => {
    setLoading(true);
    const outcome = await adminPost('model/admin/config', {}, data => modelAdminConfigViewSchema.parse(data));
    if (outcome.ok) {
      setConfig(outcome.data);
      setError(null);
      setConflict(null);
    } else {
      setError(outcome.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!providerEditor) return;
    setProbeText(null);
    providerForm.setFieldsValue(providerEditor.mode === 'edit' ? providerFormValues(providerEditor.original) : emptyProviderValues());
  }, [providerEditor, providerForm]);

  useEffect(() => {
    if (!addModelFor) return;
    setProbeText(null);
    addModelForm.setFieldsValue({
      upstream: '',
      displayName: '',
      capabilities: { ...emptyCapabilities },
      enabled: true,
      inputMissYuan: null,
      inputHitYuan: null,
      outputYuan: null,
    });
  }, [addModelFor, addModelForm]);

  useEffect(() => {
    if (!modelEditor) return;
    priceForm.setFieldsValue(priceFormValues(modelEditor));
  }, [modelEditor, priceForm]);

  useEffect(() => {
    if (!slotEditor) return;
    slotForm.setFieldsValue(slotFormValues(slotEditor.assignment));
  }, [slotEditor, slotForm]);

  async function runMutation(
    mutation: unknown,
    options: { successText: string; applyImmediately?: boolean; revision?: string; close?: () => void },
  ): Promise<ModelConfigVersion | null> {
    if (!config) return null;
    setSaving(true);
    try {
      const outcome = await adminPost(
        'model/admin/config/mutate',
        { expectedRevision: options.revision ?? config.revision, applyImmediately: options.applyImmediately, mutation },
        data => modelConfigVersionViewSchema.parse(data),
      );
      if (!outcome.ok) {
        if (outcome.status === 409 && outcome.code === 40901) setConflict(outcome.message);
        else message.error(outcome.message);
        return null;
      }
      setConflict(null);
      options.close?.();
      message.success(options.successText);
      await reload();
      return outcome.data;
    } finally {
      setSaving(false);
    }
  }

  function openCreateProvider() {
    setConflict(null);
    setProviderEditor({ mode: 'create' });
  }

  function openEditProvider(provider: ModelAdminProviderView) {
    setConflict(null);
    setProviderEditor({ mode: 'edit', original: provider });
  }

  async function submitProvider(applyImmediately: boolean) {
    try {
      const values = await providerForm.validateFields();
      if (!config || !providerEditor) return;
      const provider = toProviderInput(values);
      await runMutation(
        { kind: 'provider.upsert', provider },
        {
          successText: applyImmediately ? '提供商已保存并立即生效' : '提供商已保存',
          applyImmediately,
          close: () => {
            const id = provider.id;
            setProviderEditor(null);
            setExpanded(keys => keys.includes(id) ? keys : [...keys, id]);
          },
        },
      );
    } catch {
      // 表单校验失败：antd 已展示错误，保留输入。
    }
  }

  async function deleteProvider(provider: ModelAdminProviderView) {
    await runMutation(
      { kind: 'provider.delete', providerId: provider.id },
      { successText: `已删除提供商 ${provider.displayName}` },
    );
  }

  async function testProviderConnection() {
    try {
      const values = await providerForm.validateFields();
      setProbing(true);
      setProbeText(null);
      const outcome = await adminPost(
        'model/admin/provider/models',
        { provider: toProviderInput(values) },
        data => providerModelsViewSchema.parse(data),
      );
      if (outcome.ok) {
        setUpstreamModels(outcome.data.models);
        const ids = outcome.data.models.slice(0, 20).map(model => model.id).join('、');
        const suffix = outcome.data.models.length > 20 ? ' 等' : '';
        setProbeText(`连接正常，共 ${outcome.data.models.length} 个模型${modelListLimitHint(outcome.data.models.length)}：${ids}${suffix}`);
      } else {
        setProbeText(outcome.message);
      }
    } catch {
      // 表单校验失败。
    } finally {
      setProbing(false);
    }
  }

  async function fetchProviderModels(provider: ModelAdminProviderView, onSuccess: (models: ProviderModelsView['models']) => void) {
    setProbing(true);
    setProbeText(null);
    const outcome = await adminPost(
      'model/admin/provider/models',
      { provider: providerWriteFromView(provider) },
      data => providerModelsViewSchema.parse(data),
    );
    setProbing(false);
    if (outcome.ok) {
      onSuccess(outcome.data.models);
      message.success(`已获取 ${outcome.data.models.length} 个上游模型${modelListLimitHint(outcome.data.models.length)}`);
      return;
    }
    setProbeText(outcome.message);
    message.error(outcome.message);
  }

  function openAddModel(provider: ModelAdminProviderView) {
    setConflict(null);
    setUpstreamModels([]);
    setAddModelFor(provider);
  }

  async function fetchModelsForAddModel() {
    if (!addModelFor) return;
    await fetchProviderModels(addModelFor, models => {
      setUpstreamModels(models);
      setProbeText(`已获取 ${models.length} 个上游模型${modelListLimitHint(models.length)}`);
    });
  }

  async function submitAddModel() {
    try {
      const values = await addModelForm.validateFields();
      if (!config || !addModelFor) return;
      const providerId = addModelFor.id;
      setSaving(true);
      const created = await adminPost(
        'model/admin/config/mutate',
        {
          expectedRevision: config.revision,
          mutation: {
            kind: 'model.upsert',
            providerId,
            upstream: values.upstream.trim(),
            displayName: values.displayName.trim(),
            capabilities: values.capabilities,
            enabled: Boolean(values.enabled),
            upstreamPrice: null,
          },
        },
        data => modelConfigVersionViewSchema.parse(data),
      );
      if (!created.ok) {
        if (created.status === 409 && created.code === 40901) setConflict(created.message);
        else message.error(created.message);
        setSaving(false);
        return;
      }
      const price = priceInputOf(values.inputMissYuan, values.inputHitYuan, values.outputYuan);
      if (price) {
        const priced = await adminPost(
          'model/admin/config/mutate',
          {
            expectedRevision: created.data.revision,
            mutation: { kind: 'model.price', modelId: await findCreatedModelId(created.data.revision, providerId, values.upstream.trim()), ...price, upstreamUsd: null, note: null },
          },
          data => modelConfigVersionViewSchema.parse(data),
        );
        if (!priced.ok) {
          message.warning(priced.message);
          setSaving(false);
          await reload();
          setAddModelFor(null);
          return;
        }
      }
      setSaving(false);
      setConflict(null);
      setAddModelFor(null);
      message.success(price ? '模型已添加并配置单价' : '模型已添加，尚未定价');
      await reload();
    } catch {
      setSaving(false);
    }
  }

  /** 新建模型后从当前配置里按 (provider, upstream) 找回服务端生成的 modelId。 */
  async function findCreatedModelId(_revision: string, providerId: string, upstream: string): Promise<string> {
    const outcome = await adminPost('model/admin/config', {}, data => modelAdminConfigViewSchema.parse(data));
    if (!outcome.ok) throw new Error(outcome.message);
    const model = outcome.data.providers.find(provider => provider.id === providerId)?.models.find(candidate => candidate.upstream === upstream);
    if (!model) throw new Error('新建模型后无法定位模型标识');
    return model.id;
  }

  async function toggleModel(model: ModelAdminModelView, enabled: boolean) {
    await runMutation(
      { kind: 'model.enabled', modelId: model.id, enabled },
      { successText: enabled ? `已启用模型 ${model.displayName}` : `已停用模型 ${model.displayName}` },
    );
  }

  async function saveModelEditor() {
    if (!config || !modelEditor) return;
    try {
      const values = await priceForm.validateFields();
      let revision = config.revision;
      let changed = false;
      const displayName = values.displayName.trim();
      const modelChanged = displayName !== modelEditor.displayName
        || Boolean(values.enabled) !== modelEditor.enabled
        || JSON.stringify(values.capabilities) !== JSON.stringify(modelEditor.capabilities);
      if (modelChanged) {
        setSaving(true);
        const updated = await adminPost(
          'model/admin/config/mutate',
          {
            expectedRevision: revision,
            mutation: {
              kind: 'model.upsert',
              providerId: modelEditor.providerId,
              modelId: modelEditor.id,
              upstream: modelEditor.upstream,
              displayName,
              capabilities: values.capabilities,
              enabled: Boolean(values.enabled),
              upstreamPrice: modelEditor.upstreamPrice,
            },
          },
          data => modelConfigVersionViewSchema.parse(data),
        );
        setSaving(false);
        if (!updated.ok) {
          if (updated.status === 409 && updated.code === 40901) setConflict(updated.message);
          else message.error(updated.message);
          return;
        }
        revision = updated.data.revision;
        changed = true;
      }
      const price = priceInputOf(values.inputMissYuan, values.inputHitYuan, values.outputYuan);
      const current = modelEditor.currentPrice;
      const priceChanged = price !== null && (!current
        || current.inputMissFen !== price.inputMissFen
        || current.inputHitFen !== price.inputHitFen
        || current.outputFen !== price.outputFen
        || (values.note?.trim() || '') !== (current.note ?? ''));
      if (price && priceChanged) {
        setSaving(true);
        const priced = await adminPost(
          'model/admin/config/mutate',
          {
            expectedRevision: revision,
            mutation: { kind: 'model.price', modelId: modelEditor.id, ...price, upstreamUsd: upstreamUsdOf(modelEditor), note: values.note?.trim() || null },
          },
          data => modelConfigVersionViewSchema.parse(data),
        );
        setSaving(false);
        if (!priced.ok) {
          if (priced.status === 409 && priced.code === 40901) setConflict(priced.message);
          else message.error(priced.message);
          return;
        }
        changed = true;
      }
      if (!changed) {
        message.info('没有需要保存的修改');
        return;
      }
      setConflict(null);
      setModelEditor(null);
      message.success(priceChanged ? '模型配置已保存，单价已追加新版本' : '模型配置已保存');
      await reload();
    } catch {
      setSaving(false);
    }
  }

  async function saveSlot() {
    if (!config || !slotEditor) return;
    try {
      const values = await slotForm.validateFields();
      const settings = settingsOf(values.settings);
      await runMutation(
        { kind: 'slot.assign', slot: slotEditor.slot.slot, modelId: values.modelId, settings },
        {
          successText: '模型分配已保存',
          close: () => setSlotEditor(null),
        },
      );
    } catch {
      // 表单校验失败。
    }
  }

  async function clearSlot() {
    if (!config || !slotEditor) return;
    await runMutation(
      { kind: 'slot.clear', slot: slotEditor.slot.slot },
      {
        successText: `已清除${slotEditor.slot.label}槽位的模型分配`,
        close: () => setSlotEditor(null),
      },
    );
  }

  async function applyNow() {
    if (!config) return;
    setSaving(true);
    const outcome = await adminPost(
      'model/admin/apply',
      { expectedRevision: config.revision },
      data => modelConfigVersionViewSchema.parse(data),
    );
    setSaving(false);
    if (!outcome.ok) {
      if (outcome.status === 409 && outcome.code === 40901) setConflict(outcome.message);
      else message.error(outcome.message);
      return;
    }
    message.success('已请求所有实例立即重新加载模型配置');
    await reload();
  }

  const providerById = useMemo(
    () => new Map((config?.providers ?? []).map(provider => [provider.id, provider])),
    [config],
  );
  const modelById = useMemo(() => {
    const map = new Map<string, { provider: ModelAdminProviderView; model: ModelAdminModelView }>();
    for (const provider of config?.providers ?? []) {
      for (const model of provider.models) map.set(model.id, { provider, model });
    }
    return map;
  }, [config]);

  if (loading && !config) {
    return <main className={styles.adminPage}><p>正在加载模型配置…</p></main>;
  }

  if (!config) {
    return (
      <main className={styles.adminPage}>
        <Alert
          type="error"
          showIcon
          title="模型配置加载失败"
          description={error ?? '未知错误'}
          action={<Button size="small" onClick={() => void reload()}>重试</Button>}
        />
      </main>
    );
  }

  const providerItems = config.providers.map(provider => {
    const eligible = provider.models.filter(model => !modelEligibilityIssue(provider, model, null)).length;
    const header = (
      <div className={styles.providerHeader}>
        <div className={styles.providerTitle}>
          <strong>{provider.displayName}</strong>
          <span className={styles.slotName}>{provider.id}</span>
          {provider.enabled ? <Tag color="blue">启用</Tag> : <Tag>停用</Tag>}
          {provider.apiKeyConfigured ? <Tag color="green">密钥已配置</Tag> : <Tag color="red">密钥未配置</Tag>}
          <Tag>模型 {provider.models.length}</Tag>
          <Tag color={eligible > 0 ? 'cyan' : 'default'}>可用 {eligible}</Tag>
        </div>
        <Space onClick={event => event.stopPropagation()}>
          <Button size="small" onClick={() => openAddModel(provider)}>添加模型</Button>
          <Button size="small" onClick={() => openEditProvider(provider)}>编辑提供商</Button>
          <Popconfirm title="删除该提供商？仅空提供商可以删除" onConfirm={() => void deleteProvider(provider)}>
            <Button size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      </div>
    );
    return {
      key: provider.id,
      label: header,
      children: provider.models.length === 0 ? (
        <div className={styles.emptyModels}>
          <span>还没有配置模型</span>
          <Space wrap>
            <Button type="primary" onClick={() => openAddModel(provider)}>添加第一个模型</Button>
            <Button loading={probing} onClick={() => void fetchModelsForProvider(provider)}>从上游获取</Button>
          </Space>
        </div>
      ) : (
        <div className={styles.modelList}>
          {provider.models.map(model => (
            <ModelRow
              key={model.id}
              provider={provider}
              model={model}
              saving={saving}
              onConfigure={() => { setConflict(null); setModelEditor(model); }}
              onToggle={enabled => void toggleModel(model, enabled)}
            />
          ))}
        </div>
      ),
    };
  });

  const assignmentRows = config.slotDefinitions.map(slot => ({
    slot,
    assignment: config.assignments.find(candidate => candidate.slot === slot.slot) ?? null,
  }));

  const assignmentColumns: ColumnsType<typeof assignmentRows[number]> = [
    {
      title: '槽位',
      key: 'slot',
      render: (_, row) => (
        <div className={styles.identityCell}>
          <strong>{row.slot.label}</strong>
          <span className={styles.slotName}>{row.slot.slot}</span>
          {row.slot.optional ? <Tag>可选</Tag> : <Tag color="orange">必需</Tag>}
        </div>
      ),
    },
    { title: '用途', key: 'purpose', render: (_, row) => <span className={styles.slotPurpose}>{row.slot.purpose}</span> },
    {
      title: '当前模型',
      key: 'model',
      render: (_, row) => {
        if (!row.assignment) return <span className={styles.textGray}>未配置</span>;
        const found = modelById.get(row.assignment.modelId);
        if (!found) return <span className={styles.textGray}>模型 {row.assignment.modelId}</span>;
        return (
          <div className={styles.identityCell}>
            <span>{found.provider.displayName} / {found.model.displayName}</span>
            <span className={styles.slotName}>{found.model.upstream}</span>
            <span>{capabilityTags(found.model.capabilities)}</span>
          </div>
        );
      },
    },
    {
      title: '状态',
      key: 'status',
      render: (_, row) => {
        if (!row.assignment) return <Tag color={row.slot.optional ? 'default' : 'red'}>{row.slot.optional ? '可选未分配' : '必需槽位未分配'}</Tag>;
        const found = modelById.get(row.assignment.modelId);
        const issue = found ? modelEligibilityIssue(found.provider, found.model, row.slot) : '模型已不存在';
        return issue
          ? <div className={styles.identityCell}><Tag color="red">需重新配置</Tag><span className={styles.slotImpact}>{issue}</span></div>
          : <Tag color="green">可用</Tag>;
      },
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, row) => {
        const found = row.assignment ? modelById.get(row.assignment.modelId) : null;
        const issue = found ? modelEligibilityIssue(found.provider, found.model, row.slot) : null;
        return (
          <Button size="small" onClick={() => { setConflict(null); setSlotEditor({ slot: row.slot, assignment: row.assignment }); }}>
            {issue ? '去配置' : '配置'}
          </Button>
        );
      },
    },
  ];

  return (
    <main className={styles.adminPage}>
      <div className={styles.toolbar}>
        <h1>模型管理</h1>
        <Space className={styles.headingActions}>
          <Button onClick={() => void reload()} loading={loading}>刷新</Button>
          {config.initialized ? (
            <Popconfirm title="让所有实例立即重新加载模型配置？" onConfirm={() => void applyNow()}>
              <Button disabled={saving} loading={saving}>立即生效</Button>
            </Popconfirm>
          ) : null}
        </Space>
      </div>

      {error ? <Alert type="error" showIcon title="模型配置刷新失败" description={error} style={{ marginBottom: 16 }} /> : null}
      {conflict && !providerEditor && !addModelFor && !modelEditor && !slotEditor ? (
        <Alert
          type="error"
          showIcon
          title="操作失败：模型配置已被其他操作修改"
          description={<Space orientation="vertical" size={4}><span>{conflict}</span><Space><Button size="small" onClick={() => void reload()}>重新加载</Button><Button size="small" onClick={() => setConflict(null)}>忽略</Button></Space></Space>}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {!config.initialized ? (
        <>
          <Alert
            type="info"
            showIcon
            title="模型配置尚未初始化"
            description={
              <div>
                <p>当前数据库中没有可用的模型提供商与槽位分配。请在服务器上执行一次初始化命令，从环境变量导入默认提供商与必需槽位：</p>
                <p><code>npm run db:init-models</code></p>
                <p>初始化完成后再点击“刷新”。本页面不会自动初始化，也不会写入任何密钥。</p>
              </div>
            }
          />
          <Empty description="暂无模型配置" style={{ marginTop: 24 }} />
        </>
      ) : (
        <>
          <div className={styles.sectionHeading}>
            <h2>当前实例状态</h2>
            <span className={styles.statusHint}>仅反映处理本次请求的实例，其他实例可能尚未刷新</span>
          </div>
          <Descriptions
            bordered
            size="small"
            column={2}
            items={[
              { key: 'revision', label: '数据库配置版本', children: config.revision },
              { key: 'instanceRevision', label: '实例生效版本', children: config.instance.revision ?? '未加载' },
              { key: 'source', label: '实例配置来源', children: config.instance.source === 'database' ? '数据库' : config.instance.source === 'environment' ? '环境变量' : '未知' },
              { key: 'epoch', label: '实例刷新批次', children: config.instance.refreshEpoch ?? '未加载' },
              { key: 'degraded', label: '实例状态', children: config.instance.degraded ? <Tag color="red">降级</Tag> : <Tag color="green">正常</Tag> },
              { key: 'bytes', label: '配置文档大小', children: `${config.documentBytes} 字节` },
              { key: 'readAt', label: '最近读取时间', children: formatClock(config.instance.readAt) },
              { key: 'lastError', label: '最近错误', children: config.instance.lastError ?? '无' },
            ]}
          />

          <div className={styles.sectionHeading}>
            <h2>提供商与模型</h2>
            <div className={styles.headingActions}>
              <Button type="primary" onClick={openCreateProvider} disabled={saving}>新增提供商</Button>
            </div>
          </div>
          <Collapse
            className={styles.providerCollapse}
            activeKey={expanded}
            onChange={keys => setExpanded(Array.isArray(keys) ? keys.map(String) : [String(keys)])}
            items={providerItems}
          />
          {config.providers.length === 0 ? <Empty description="还没有提供商" style={{ marginTop: 16 }} /> : null}

          <div className={styles.sectionHeading}>
            <h2>模型分配</h2>
            <span className={styles.statusHint}>四个槽位由代码定义；下拉只列出已启用、已定价且能力满足的模型</span>
          </div>
          <Table
            rowKey={row => row.slot.slot}
            size="small"
            dataSource={assignmentRows}
            pagination={false}
            scroll={{ x: 760 }}
            columns={assignmentColumns}
          />
        </>
      )}

      {providerEditor ? (
        <Modal
          open
          title={providerEditor.mode === 'create' ? '新增提供商' : '编辑提供商'}
          destroyOnHidden
          width={720}
          onCancel={() => { if (!saving) setProviderEditor(null); }}
          footer={
            <Space>
              <Button onClick={() => setProviderEditor(null)} disabled={saving}>取消</Button>
              <Button onClick={() => void submitProvider(true)} loading={saving}>保存并立即生效</Button>
              <Button type="primary" onClick={() => void submitProvider(false)} loading={saving}>保存</Button>
            </Space>
          }
        >
          {conflict ? <ConflictAlert message={conflict} onReload={() => void reload()} /> : null}
          <Form form={providerForm} layout="vertical" preserve={false}>
            <Form.Item name="id" label="提供商 ID" tooltip="稳定标识，创建后不可修改" rules={[
              { required: true, message: '请输入提供商 ID' },
              { max: 64, message: '最多 64 个字符' },
              { pattern: /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, message: '仅小写字母、数字、点、下划线、连字符，且首尾为字母或数字' },
            ]}>
              <Input disabled={providerEditor.mode === 'edit'} placeholder="例如 env-default" aria-label="提供商 ID" />
            </Form.Item>
            <Form.Item name="displayName" label="名称" rules={[{ required: true, message: '请输入名称' }, { max: 128, message: '最多 128 个字符' }]}>
              <Input aria-label="名称" />
            </Form.Item>
            <Form.Item name="apiFormat" label="API 格式" rules={[{ required: true, message: '请选择 API 格式' }]}>
              <Select
                aria-label="API 格式"
                options={modelProviderFormatViews.map(format => ({ value: format.value, label: format.label }))}
                onChange={(value: ProviderApiFormat) => providerForm.setFieldValue('options', pickProviderOptions(value, providerForm.getFieldValue('options')))}
              />
            </Form.Item>
            <Form.Item name="baseUrl" label="地址" rules={[{ required: true, message: '请输入地址' }, { max: 2048, message: '最多 2048 个字符' }]}>
              <Input aria-label="地址" placeholder="https://api.example.com/v1" />
            </Form.Item>
            <Form.Item name="apiKeySource" label="密钥来源" rules={[{ required: true, message: '请选择密钥来源' }]}>
              <Select aria-label="密钥来源" options={[{ value: 'env', label: '引用环境变量' }, { value: 'inline', label: '直接输入密钥' }]} />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(previous, current) => previous.apiKeySource !== current.apiKeySource}>
              {({ getFieldValue }) => getFieldValue('apiKeySource') === 'env' ? (
                <Form.Item name="apiKeyEnv" label="密钥环境变量" rules={[{ required: true, message: '请选择密钥环境变量' }]}>
                  <Select aria-label="密钥环境变量" options={config.allowedApiKeyEnvs.map(name => ({ value: name, label: name }))} />
                </Form.Item>
              ) : (
                <Form.Item
                  name="apiKey"
                  label="密钥"
                  tooltip="保存后仅以密文入库；编辑时留空表示保持已保存的密钥"
                  rules={[{ required: !(providerEditor.mode === 'edit' && providerEditor.original.apiKeySource === 'inline'), message: '请输入密钥' }, { max: 1024, message: '最多 1024 个字符' }]}
                >
                  <Input.Password aria-label="密钥" autoComplete="new-password" placeholder="直接粘贴上游密钥" />
                </Form.Item>
              )}
            </Form.Item>
            <Form.Item label="连通性" tooltip="按当前填写的地址与密钥请求一次上游 /models，只做检测，不保存配置">
              <Space orientation="vertical" size={4} style={{ width: '100%' }}>
                <Button onClick={() => void testProviderConnection()} loading={probing} aria-label="测试连接">测试连接</Button>
                {probeText ? <span className={styles.textGray}>{probeText}</span> : null}
              </Space>
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(previous, current) => previous.apiFormat !== current.apiFormat}>
              {({ getFieldValue }) => {
                const optionKeys = providerOptionKeysByFormat[getFieldValue('apiFormat') as ProviderApiFormat] ?? [];
                const choiceKeys = optionKeys.filter(isChoiceOptionKey);
                const switchKeys = optionKeys.filter(key => !isChoiceOptionKey(key));
                return (
                  <Form.Item label="提供商选项" tooltip="不同 API 格式支持的协议选项不同">
                    {optionKeys.length === 0 ? <span className={styles.textGray}>该 API 格式没有可配置的选项</span> : (
                      <Space orientation="vertical" size={8}>
                        {choiceKeys.map(key => (
                          <Space key={key} size={8}>
                            <span>{modelProviderOptionLabels[key]}</span>
                            <Form.Item name={['options', key]} noStyle>
                              <Select allowClear aria-label={modelProviderOptionLabels[key]} placeholder="不指定" options={[...modelProviderOptionChoices[key]]} style={{ minWidth: 180 }} />
                            </Form.Item>
                          </Space>
                        ))}
                        {switchKeys.length ? (
                          <Space size={16} wrap>
                            {switchKeys.map(key => (
                              <Space key={key} size={8}>
                                <span>{modelProviderOptionLabels[key]}</span>
                                <Form.Item name={['options', key]} valuePropName="checked" noStyle>
                                  <Switch aria-label={modelProviderOptionLabels[key]} />
                                </Form.Item>
                              </Space>
                            ))}
                          </Space>
                        ) : null}
                      </Space>
                    )}
                  </Form.Item>
                );
              }}
            </Form.Item>
            <Form.Item label="自定义请求头" tooltip="随每个上游请求发送；鉴权与传输头由系统生成，不能覆盖">
              <Form.List name="requestHeaders">
                {(fields, { add, remove }) => (
                  <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                    {fields.map(field => (
                      <Space key={field.key} size={8} align="start">
                        <Form.Item preserve name={[field.name, 'name']} rules={[
                          { required: true, message: '请输入请求头名称' },
                          { validator: (_rule, value) => {
                            if (value === undefined || value === null || value === '') return Promise.resolve();
                            const parsed = providerHeaderNameSchema.safeParse(value);
                            if (!parsed.success) return Promise.reject(new Error(parsed.error.issues[0]?.message ?? '请求头名称不合法'));
                            const rows: ProviderHeaderRow[] = providerForm.getFieldValue('requestHeaders') ?? [];
                            const target = String(value).trim().toLowerCase();
                            return rows.filter(row => (row?.name ?? '').trim().toLowerCase() === target).length > 1
                              ? Promise.reject(new Error('请求头名称重复'))
                              : Promise.resolve();
                          } },
                        ]}>
                          <Input aria-label="请求头名称" placeholder="User-Agent" />
                        </Form.Item>
                        <Form.Item preserve name={[field.name, 'value']} rules={[
                          { required: true, message: '请输入请求头值' },
                          { validator: (_rule, value) => {
                            if (value === undefined || value === null || value === '') return Promise.resolve();
                            const parsed = providerHeaderValueSchema.safeParse(value);
                            return parsed.success ? Promise.resolve() : Promise.reject(new Error(parsed.error.issues[0]?.message ?? '请求头值不合法'));
                          } },
                        ]}>
                          <Input aria-label="请求头值" placeholder="paimeng-ai-code-mother/1.0" />
                        </Form.Item>
                        <Button danger onClick={() => remove(field.name)} aria-label="删除请求头">删除</Button>
                      </Space>
                    ))}
                    <Button onClick={() => add({ name: '', value: '' })} disabled={fields.length >= providerHeaderLimit} aria-label="添加请求头">添加请求头</Button>
                  </Space>
                )}
              </Form.List>
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch aria-label="启用" /></Form.Item>
          </Form>
        </Modal>
      ) : null}

      {addModelFor ? (
        <Modal
          open
          title={`在 ${addModelFor.displayName} 下添加模型`}
          destroyOnHidden
          width={680}
          onCancel={() => { if (!saving) setAddModelFor(null); }}
          footer={
            <Space>
              <Button onClick={() => setAddModelFor(null)} disabled={saving}>取消</Button>
              <Button type="primary" onClick={() => void submitAddModel()} loading={saving}>添加模型</Button>
            </Space>
          }
        >
          {conflict ? <ConflictAlert message={conflict} onReload={() => void reload()} /> : null}
          <Form form={addModelForm} layout="vertical" preserve={false}>
            <Descriptions size="small" column={1} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="提供商">{addModelFor.displayName}（{addModelFor.id}）</Descriptions.Item>
            </Descriptions>
            <div className={styles.stackRow}>
              <Form.Item name="upstream" label="上游模型名" tooltip="请求实际使用的模型名；创建后不可修改" rules={[{ required: true, message: '请输入上游模型名' }, { max: 256, message: '最多 256 个字符' }]} style={{ flex: 1, minWidth: 0 }}>
                <AutoComplete
                  style={{ width: '100%' }}
                  aria-label="上游模型名"
                  placeholder="例如 deepseek-chat"
                  options={upstreamModels.map(model => ({ value: model.id, label: model.label }))}
                  filterOption={(input, option) => `${option?.value ?? ''} ${option?.label ?? ''}`.toLowerCase().includes(input.toLowerCase())}
                />
              </Form.Item>
              <Button onClick={() => void fetchModelsForAddModel()} loading={probing} className={styles.fetchButton}>获取上游模型</Button>
            </div>
            {probeText ? <div className={styles.textGray}>{probeText}</div> : null}
            <Form.Item name="displayName" label="显示名称" rules={[{ required: true, message: '请输入显示名称' }, { max: 256, message: '最多 256 个字符' }]}>
              <Input aria-label="显示名称" placeholder="例如 DeepSeek Chat" />
            </Form.Item>
            <Form.Item label="能力" tooltip="能力属于模型本身，所有引用它的槽位共用">
              <Space size={16} wrap>
                {(['streaming', 'toolCalling', 'structuredOutput', 'imageInput'] as const).map(capability => (
                  <span key={capability}>
                    <Form.Item name={['capabilities', capability]} valuePropName="checked" noStyle>
                      <Switch aria-label={modelCapabilityLabels[capability]} />
                    </Form.Item>
                    <span>{modelCapabilityLabels[capability]}</span>
                  </span>
                ))}
              </Space>
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch aria-label="启用" /></Form.Item>
            <div className={styles.sectionHeading}><h3>初始单价（可选）</h3><span className={styles.statusHint}>人民币 / 1M tokens；留空表示先登记为未定价，不能分配槽位</span></div>
            <div className={styles.priceInputs}>
              <Form.Item name="inputMissYuan" label="输入未命中" rules={[{ type: 'number', min: 0, message: '单价不能是负数' }]}>
                <InputNumber min={0} step={0.01} precision={2} aria-label="输入未命中单价" style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="inputHitYuan" label="输入命中" rules={[{ type: 'number', min: 0, message: '单价不能是负数' }]}>
                <InputNumber min={0} step={0.01} precision={2} aria-label="输入命中单价" style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="outputYuan" label="输出" rules={[{ type: 'number', min: 0, message: '单价不能是负数' }]}>
                <InputNumber min={0} step={0.01} precision={2} aria-label="输出单价" style={{ width: '100%' }} />
              </Form.Item>
            </div>
          </Form>
        </Modal>
      ) : null}

      <Drawer
        open={Boolean(modelEditor)}
        title={modelEditor ? `配置模型 · ${modelEditor.displayName}` : '配置模型'}
        width={620}
        destroyOnHidden
        onClose={() => { if (!saving) setModelEditor(null); }}
        extra={modelEditor ? (
          <Space>
            <Button onClick={() => setModelEditor(null)} disabled={saving}>取消</Button>
            <Button type="primary" onClick={() => void saveModelEditor()} loading={saving}>保存</Button>
          </Space>
        ) : null}
      >
        {modelEditor ? (
          <>
            {conflict ? <ConflictAlert message={conflict} onReload={() => void reload()} /> : null}
            <Descriptions size="small" column={1} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="提供商">{providerById.get(modelEditor.providerId)?.displayName ?? modelEditor.providerId}</Descriptions.Item>
              <Descriptions.Item label="上游模型名"><code>{modelEditor.upstream}</code></Descriptions.Item>
              <Descriptions.Item label="模型标识"><span className={styles.slotName}>{modelEditor.id}</span></Descriptions.Item>
              <Descriptions.Item label="上游参考价">
                {modelEditor.upstreamPrice
                  ? `${formatUsd(modelEditor.upstreamPrice.inputMiss)} · ${formatUsd(modelEditor.upstreamPrice.inputHit)} · ${formatUsd(modelEditor.upstreamPrice.output)} USD / 1M`
                  : '未记录（上游价只作参考，不参与售价计算）'}
              </Descriptions.Item>
              <Descriptions.Item label="当前单价">
                {modelEditor.currentPrice
                  ? `${formatCny(modelEditor.currentPrice.inputMissFen)} · ${formatCny(modelEditor.currentPrice.inputHitFen)} · ${formatCny(modelEditor.currentPrice.outputFen)} / 1M（版本 ${modelEditor.currentPrice.version}）`
                  : <Tag color="red">未定价</Tag>}
              </Descriptions.Item>
            </Descriptions>
            <Form form={priceForm} layout="vertical" preserve={false}>
              <Form.Item name="displayName" label="显示名称" rules={[{ required: true, message: '请输入显示名称' }, { max: 256, message: '最多 256 个字符' }]}>
                <Input aria-label="显示名称" />
              </Form.Item>
              <Form.Item label="能力" tooltip="能力属于模型本身，所有引用它的槽位共用；修改后请检查槽位状态">
                <Space size={16} wrap>
                  {(['streaming', 'toolCalling', 'structuredOutput', 'imageInput'] as const).map(capability => (
                    <span key={capability}>
                      <Form.Item name={['capabilities', capability]} valuePropName="checked" noStyle>
                        <Switch aria-label={modelCapabilityLabels[capability]} />
                      </Form.Item>
                      <span>{modelCapabilityLabels[capability]}</span>
                    </span>
                  ))}
                </Space>
              </Form.Item>
              <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch aria-label="启用" /></Form.Item>
              <div className={styles.priceInputs}>
                <Form.Item name="inputMissYuan" label="输入未命中（¥ / 1M）" rules={[{ type: 'number', min: 0, message: '单价不能是负数' }]}>
                  <InputNumber min={0} step={0.01} precision={2} aria-label="输入未命中单价" style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item name="inputHitYuan" label="输入命中（¥ / 1M）" rules={[{ type: 'number', min: 0, message: '单价不能是负数' }]}>
                  <InputNumber min={0} step={0.01} precision={2} aria-label="输入命中单价" style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item name="outputYuan" label="输出（¥ / 1M）" rules={[{ type: 'number', min: 0, message: '单价不能是负数' }]}>
                  <InputNumber min={0} step={0.01} precision={2} aria-label="输出单价" style={{ width: '100%' }} />
                </Form.Item>
              </div>
              <Form.Item name="note" label="价格备注" rules={[{ max: 2000, message: '最多 2000 个字符' }]}>
                <Input.TextArea rows={2} aria-label="价格备注" />
              </Form.Item>
              <div className={styles.statusHint}>保存单价会追加一个新版本；历史账单保留当时的快照，不会重算。没有倍率、汇率或自动按上游价生成售价。</div>
            </Form>
            <div className={styles.sectionHeading}><h3>价格版本</h3></div>
            <Table<ModelPriceVersion>
              rowKey="version"
              size="small"
              pagination={false}
              dataSource={[...modelEditor.prices].sort((left, right) => right.version - left.version)}
              scroll={{ x: 520 }}
              columns={[
                { title: '版本', dataIndex: 'version', width: 70 },
                { title: '生效时间（UTC）', dataIndex: 'effectiveAt', width: 200 },
                { title: '输入未命中', dataIndex: 'inputMissFen', align: 'right', render: value => formatCny(value) },
                { title: '输入命中', dataIndex: 'inputHitFen', align: 'right', render: value => formatCny(value) },
                { title: '输出', dataIndex: 'outputFen', align: 'right', render: value => formatCny(value) },
              ]}
            />
          </>
        ) : null}
      </Drawer>

      {slotEditor ? (
        <Modal
          open
          title={`配置${slotEditor.slot.label}`}
          destroyOnHidden
          onCancel={() => { if (!saving) setSlotEditor(null); }}
          footer={
            <Space>
              <Button onClick={() => setSlotEditor(null)} disabled={saving}>取消</Button>
              {slotEditor.slot.optional && slotEditor.assignment ? (
                <Popconfirm title="清除这个槽位的模型分配？" onConfirm={() => void clearSlot()}>
                  <Button danger disabled={saving}>清除分配</Button>
                </Popconfirm>
              ) : null}
              <Button type="primary" onClick={() => void saveSlot()} loading={saving}>保存</Button>
            </Space>
          }
        >
          {conflict ? <ConflictAlert message={conflict} onReload={() => void reload()} /> : null}
          <Descriptions size="small" column={1} style={{ marginBottom: 16 }}>
            <Descriptions.Item label="槽位">{slotEditor.slot.label}<span className={styles.slotName} style={{ marginLeft: 8 }}>{slotEditor.slot.slot}</span></Descriptions.Item>
            <Descriptions.Item label="用途">{slotEditor.slot.purpose}</Descriptions.Item>
            <Descriptions.Item label="要求能力">{slotEditor.slot.requires.length ? slotEditor.slot.requires.map(item => modelCapabilityLabels[item]).join('、') : '无硬性要求'}</Descriptions.Item>
          </Descriptions>
          <Form form={slotForm} layout="vertical" preserve={false}>
            {slotEditor.assignment ? (() => {
              const found = modelById.get(slotEditor.assignment.modelId);
              const issue = found ? modelEligibilityIssue(found.provider, found.model, slotEditor.slot) : '模型已不存在';
              return issue ? <Alert type="warning" showIcon title="当前分配不可用" description={issue} style={{ marginBottom: 16 }} /> : null;
            })() : null}
            <Form.Item name="modelId" label="模型" rules={[{ required: true, message: '请选择模型' }]}>
              <Select
                aria-label="模型"
                placeholder="选择已启用、已定价且能力满足的模型"
                options={eligibleOptions(config, slotEditor.slot, slotEditor.assignment)}
              />
            </Form.Item>
            <Space size={16} wrap>
              <Form.Item name={['settings', 'temperature']} label="temperature" rules={[{ type: 'number', min: 0, max: 2, message: 'temperature 需在 0 到 2 之间' }]}>
                <InputNumber min={0} max={2} step={0.1} aria-label="temperature" />
              </Form.Item>
              <Form.Item name={['settings', 'topP']} label="topP" rules={[{ type: 'number', min: 0, max: 1, message: 'topP 需在 0 到 1 之间' }]}>
                <InputNumber min={0} max={1} step={0.05} aria-label="topP" />
              </Form.Item>
              <Form.Item name={['settings', 'maxOutputTokens']} label="最大输出 tokens" rules={[{ type: 'integer', min: 1, max: 1000000, message: '最大输出 tokens 需为 1 到 1000000 的整数' }]}>
                <InputNumber min={1} max={1000000} step={1} precision={0} aria-label="最大输出 tokens" />
              </Form.Item>
              <Form.Item name={['settings', 'reasoning']} label="思考强度">
                <Select allowClear aria-label="思考强度" placeholder="不指定" style={{ minWidth: 140 }} options={reasoningLevels.map(level => ({ value: level, label: reasoningLevelLabels[level] }))} />
              </Form.Item>
              <Form.Item name={['settings', 'reasoningContentPassthrough']} label="回传思考内容" valuePropName="checked">
                <Switch aria-label="回传思考内容" />
              </Form.Item>
            </Space>
          </Form>
        </Modal>
      ) : null}
    </main>
  );

  async function fetchModelsForProvider(provider: ModelAdminProviderView) {
    await fetchProviderModels(provider, models => {
      openAddModel(provider);
      setUpstreamModels(models);
      setProbeText(`已获取 ${models.length} 个上游模型${modelListLimitHint(models.length)}`);
    });
  }
}

function ModelRow(props: {
  provider: ModelAdminProviderView;
  model: ModelAdminModelView;
  saving: boolean;
  onConfigure: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const { provider, model, saving, onConfigure, onToggle } = props;
  const current = model.currentPrice ?? currentPriceOf(model);
  const issue = modelEligibilityIssue(provider, model, null);
  const upstream = model.upstreamPrice;
  return (
    <section className={styles.modelRow} aria-label={`模型 ${model.displayName}`}>
      <div className={styles.modelMain}>
        <div className={styles.identityCell}>
          <strong>{model.displayName}</strong>
          <span className={styles.slotName}>{model.upstream}</span>
        </div>
        <div>{capabilityTags(model.capabilities)}</div>
      </div>
      <div className={styles.modelPrices}>
        {current ? (
          <>
            <span><i>未命中</i><b>{formatCny(current.inputMissFen)}</b></span>
            <span><i>命中</i><b>{formatCny(current.inputHitFen)}</b></span>
            <span><i>输出</i><b>{formatCny(current.outputFen)}</b></span>
            <span className={styles.statusHint}>版本 {current.version} · {current.effectiveAt} UTC</span>
          </>
        ) : <Tag color="red">未定价</Tag>}
      </div>
      <div className={styles.modelUpstream}>
        <span className={styles.statusHint}>上游参考</span>
        <span>{upstream ? `${formatUsd(upstream.inputMiss)} · ${formatUsd(upstream.inputHit)} · ${formatUsd(upstream.output)} USD / 1M` : '未记录'}</span>
      </div>
      <div className={styles.modelActions}>
        {issue ? <Tag color="orange">不可分配</Tag> : <Tag color="green">可分配</Tag>}
        <Switch checked={model.enabled} onChange={onToggle} disabled={saving} aria-label={`启用模型 ${model.displayName}`} />
        <Button size="small" onClick={onConfigure}>配置</Button>
      </div>
    </section>
  );
}

function ConflictAlert({ message, onReload }: { message: string; onReload: () => void }) {
  return (
    <Alert
      type="error"
      showIcon
      title="保存失败：模型配置已被其他操作修改"
      description={
        <Space orientation="vertical" size={4}>
          <span>{message}</span>
          <span>当前输入已保留，可先重新加载最新配置再保存。</span>
          <Button size="small" onClick={onReload}>重新加载</Button>
        </Space>
      }
      style={{ marginBottom: 16 }}
    />
  );
}

function eligibleOptions(config: ModelAdminConfigView, slot: ModelSlotView, current: ModelAssignmentView | null) {
  const options: { value: string; label: string; disabled?: boolean }[] = [];
  for (const provider of config.providers) {
    for (const model of provider.models) {
      const issue = modelEligibilityIssue(provider, model, slot);
      if (issue) continue;
      options.push({
        value: model.id,
        label: `${provider.displayName} / ${model.displayName}（${model.upstream}）`,
      });
    }
  }
  if (current && !options.some(option => option.value === current.modelId)) {
    const found = config.providers.flatMap(provider => provider.models.map(model => ({ provider, model }))).find(item => item.model.id === current.modelId);
    options.unshift({
      value: current.modelId,
      label: found ? `${found.provider.displayName} / ${found.model.displayName}（当前分配，不可用）` : `${current.modelId}（当前分配，不可用）`,
      disabled: true,
    });
  }
  return options;
}

function priceInputOf(miss: number | null | undefined, hit: number | null | undefined, output: number | null | undefined) {
  const inputMissFen = yuanToFen(miss);
  const inputHitFen = yuanToFen(hit);
  const outputFen = yuanToFen(output);
  if (inputMissFen === null && inputHitFen === null && outputFen === null) return null;
  return {
    inputMissFen: inputMissFen ?? 0,
    inputHitFen: inputHitFen ?? 0,
    outputFen: outputFen ?? 0,
  };
}

function upstreamUsdOf(model: ModelAdminModelView) {
  const upstream = model.upstreamPrice;
  if (!upstream) return null;
  return { inputMiss: upstream.inputMiss, inputHit: upstream.inputHit, output: upstream.output };
}

function priceFormValues(model: ModelAdminModelView): PriceFormValues {
  const current = model.currentPrice;
  return {
    displayName: model.displayName,
    capabilities: { ...model.capabilities },
    enabled: model.enabled,
    inputMissYuan: current ? fenToYuan(current.inputMissFen) : null,
    inputHitYuan: current ? fenToYuan(current.inputHitFen) : null,
    outputYuan: current ? fenToYuan(current.outputFen) : null,
    note: '',
  };
}

function slotFormValues(assignment: ModelAssignmentView | null): SlotFormValues {
  return {
    modelId: assignment?.modelId ?? '',
    settings: {
      temperature: assignment?.settings.temperature ?? null,
      topP: assignment?.settings.topP ?? null,
      maxOutputTokens: assignment?.settings.maxOutputTokens ?? null,
      reasoning: assignment?.settings.reasoning ?? null,
      reasoningContentPassthrough: assignment?.settings.reasoningContentPassthrough ?? false,
    },
  };
}

function settingsOf(settings: SlotFormValues['settings']): ModelAliasSettings {
  const next: ModelAliasSettings = {};
  if (typeof settings?.temperature === 'number') next.temperature = settings.temperature;
  if (typeof settings?.topP === 'number') next.topP = settings.topP;
  if (typeof settings?.maxOutputTokens === 'number') next.maxOutputTokens = settings.maxOutputTokens;
  if (settings?.reasoning) next.reasoning = settings.reasoning;
  if (settings?.reasoningContentPassthrough) next.reasoningContentPassthrough = true;
  return next;
}

async function adminPost<T>(path: string, payload: unknown, parse: (data: unknown) => T): Promise<AdminOutcome<T>> {
  try {
    const response = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const data = await readApiResponse(response);
    try {
      return { ok: true, data: parse(data) };
    } catch {
      return { ok: false, status: response.status, code: 0, message: '响应格式不正确' };
    }
  } catch (error) {
    if (error instanceof ApiResponseError) return { ok: false, status: error.status, code: error.code, message: error.message };
    return { ok: false, status: 0, code: 0, message: '网络请求失败，请稍后重试' };
  }
}

function emptyProviderValues(): ProviderFormValues {
  return {
    id: '',
    displayName: '',
    apiFormat: modelProviderFormatViews[0]?.value ?? 'openai-chat',
    baseUrl: '',
    apiKeySource: 'env',
    apiKeyEnv: baseModelApiKeyEnv,
    apiKey: '',
    options: {},
    requestHeaders: [],
    enabled: true,
  };
}

function providerFormValues(provider: ModelAdminProviderView): ProviderFormValues {
  return {
    id: provider.id,
    displayName: provider.displayName,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    apiKeySource: provider.apiKeySource,
    apiKeyEnv: provider.apiKeySource === 'env' ? provider.apiKeyEnv : baseModelApiKeyEnv,
    apiKey: '',
    options: { ...provider.options },
    requestHeaders: Object.entries(provider.headers ?? {}).map(([name, value]) => ({ name, value })),
    enabled: provider.enabled,
  };
}

function providerWriteFromView(provider: ModelAdminProviderView): ModelProviderWriteInput {
  const common = {
    id: provider.id,
    displayName: provider.displayName,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    options: provider.options,
    headers: provider.headers ?? {},
    enabled: provider.enabled,
  };
  return provider.apiKeySource === 'env'
    ? { ...common, apiKeySource: 'env', apiKeyEnv: provider.apiKeyEnv }
    : { ...common, apiKeySource: 'inline', apiKey: '' };
}

function toProviderInput(values: ProviderFormValues): ModelProviderWriteInput {
  const common = {
    id: values.id.trim(),
    displayName: values.displayName.trim(),
    apiFormat: values.apiFormat,
    baseUrl: values.baseUrl.trim(),
    options: pickProviderOptions(values.apiFormat, values.options),
    headers: providerHeadersFromRows(values.requestHeaders),
    enabled: Boolean(values.enabled),
  };
  return values.apiKeySource === 'env'
    ? { ...common, apiKeySource: 'env' as const, apiKeyEnv: values.apiKeyEnv }
    : { ...common, apiKeySource: 'inline' as const, apiKey: values.apiKey ?? '' };
}

function pickProviderOptions(apiFormat: ProviderApiFormat, options: ModelProviderOptions | undefined): ModelProviderOptions {
  const allowed = providerOptionKeysByFormat[apiFormat];
  const candidate: Record<string, unknown> = {};
  for (const key of modelProviderOptionKeys) {
    if (!allowed.includes(key)) continue;
    const value = options?.[key];
    if (value === undefined || value === null) continue;
    candidate[key] = value;
  }
  const parsed = providerOptionsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : {};
}

function providerHeadersFromRows(rows: ProviderHeaderRow[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of rows ?? []) {
    const name = row?.name?.trim() ?? '';
    if (!name) continue;
    headers[name] = row?.value ?? '';
  }
  return headers;
}

function isChoiceOptionKey(key: string): key is 'thinkingSwitch' {
  return modelProviderChoiceOptionKeys.includes(key as never);
}

function capabilityTags(capabilities: { streaming: boolean; toolCalling: boolean; structuredOutput: boolean; imageInput: boolean }) {
  const active = (['streaming', 'toolCalling', 'structuredOutput', 'imageInput'] as const).filter(key => capabilities[key]);
  if (!active.length) return <span className={styles.textGray}>无</span>;
  return active.map(key => <Tag key={key}>{modelCapabilityLabels[key]}</Tag>);
}

function modelListLimitHint(count: number): string {
  return count >= providerModelListLimit ? `（已达到 ${providerModelListLimit} 条上限，其余未显示）` : '';
}

function formatClock(value: number | null): string {
  return value === null ? '—' : new Date(value).toLocaleString();
}
