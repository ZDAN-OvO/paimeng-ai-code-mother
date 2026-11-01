'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Descriptions,
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
import { RateCardPanel } from './billing/rate-card-panel';
import styles from './admin-view.module.css';
import {
  baseModelApiKeyEnv,
  modelCapabilityLabels,
  missingSlotCapabilities,
  modelAdminConfigViewSchema,
  modelConfigVersionSchema,
  modelProviderChoiceOptionKeys,
  modelProviderOptionChoices,
  modelProviderOptionLabels,
  modelProviderOptionKeys,
  providerHeaderLimit,
  providerHeaderNameSchema,
  providerHeaderValueSchema,
  providerOptionKeysByFormat,
  providerOptionsSchema,
  providerModelListLimit,
  providerModelsViewSchema,
  providerModelWriteResultSchema,
  reasoningLevelLabels,
  reasoningLevels,
  type ModelProviderOptionKey,
  providerApiFormats,
  type ModelAdminConfigView,
  type ModelAlias,
  type ModelAliasCapabilities,
  type ModelAliasInput,
  type ModelAliasSettings,
  type ModelConfigVersion,
  type ModelProviderOptions,
  type ModelProviderView,
  type ModelSlotView,
  type ModelProviderWriteInput,
  type ProviderModelInput,
  type ProviderModelView,
  type ProviderModelsView,
  type ProviderApiFormat,
  type ProviderKeySource,
  type ReasoningLevel,
} from '@/shared/model-config';

/** 上游列表在服务端按 providerModelListLimit 截断，命中上限时明确告知，避免管理员以为模型丢了。 */
function modelListLimitHint(count: number): string {
  return count >= providerModelListLimit ? `（已达到 ${providerModelListLimit} 条上限，其余未显示）` : '';
}

type AdminOutcome<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

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

type AliasFormValues = {
  providerModelId?: string;
  settings: {
    temperature?: number | null;
    topP?: number | null;
    maxOutputTokens?: number | null;
    reasoning?: ReasoningLevel | null;
  };
  enabled: boolean;
};

type ProviderModelFormValues = {
  providerId: string;
  upstreamModelName: string;
  displayName: string;
  capabilities: ModelAliasCapabilities;
  compatibility: { reasoningContentPassthrough: boolean };
  enabled: boolean;
};

type ProviderEditor = { mode: 'create' } | { mode: 'edit'; original: ModelProviderView };
type ProviderModelEditor =
  | { mode: 'create'; providerId?: string }
  | { mode: 'edit'; original: ProviderModelView };
type AliasEditor = { slot: ModelSlotView; original: ModelAlias } | { slot: ModelSlotView };

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
  const [providerEditor, setProviderEditor] = useState<ProviderEditor | null>(null);
  const [providerModelEditor, setProviderModelEditor] = useState<ProviderModelEditor | null>(null);
  const [aliasEditor, setAliasEditor] = useState<AliasEditor | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeText, setProbeText] = useState<string | null>(null);
  const [modelProbing, setModelProbing] = useState(false);
  const [modelProbeText, setModelProbeText] = useState<string | null>(null);
  const [modelProbeOk, setModelProbeOk] = useState(false);
  const [modelCandidates, setModelCandidates] = useState<ProviderModelsView['models']>([]);
  const [providerForm] = Form.useForm<ProviderFormValues>();
  const [providerModelForm] = Form.useForm<ProviderModelFormValues>();
  const [aliasForm] = Form.useForm<AliasFormValues>();

  const reload = useCallback(async () => {
    setLoading(true);
    const outcome = await adminPost('model/admin/config', {}, (data) => modelAdminConfigViewSchema.parse(data));
    if (outcome.ok) {
      setConfig(outcome.data);
      setError(null);
      setConflict(null);
    } else {
      setError(outcome.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function runOperation<T>(
    operation: () => Promise<AdminOutcome<T>>,
    onSuccess: () => void,
    successText: string,
  ) {
    setSaving(true);
    try {
      const outcome = await operation();
      if (outcome.ok) {
        setConflict(null);
        onSuccess();
        message.success(successText);
        await reload();
        return;
      }
      if (outcome.status === 409) {
        setConflict(outcome.message);
        return;
      }
      message.error(outcome.message);
    } finally {
      setSaving(false);
    }
  }

  function openCreateProvider() {
    setConflict(null);
    setProviderEditor({ mode: 'create' });
  }

  function openEditProvider(row: ModelProviderView) {
    setConflict(null);
    setProviderEditor({ mode: 'edit', original: row });
  }

  function openCreateProviderModel(providerId?: string) {
    setConflict(null);
    setProviderModelEditor({ mode: 'create', providerId: providerId ?? config?.providers[0]?.id });
  }

  function openEditProviderModel(row: ProviderModelView) {
    setConflict(null);
    setProviderModelEditor({ mode: 'edit', original: row });
  }

  function openAliasEditor(slot: ModelSlotView, original?: ModelAlias) {
    setConflict(null);
    setAliasEditor(original ? { slot, original } : { slot });
  }

  function closeProviderEditor() {
    setProviderEditor(null);
    setConflict(null);
  }

  function closeProviderModelEditor() {
    setProviderModelEditor(null);
    setConflict(null);
  }

  function closeAliasEditor() {
    setAliasEditor(null);
    setConflict(null);
  }

  useEffect(() => {
    if (!providerEditor) return;
    setProbeText(null);
    providerForm.setFieldsValue(
      providerEditor.mode === 'edit' ? providerFormValues(providerEditor.original) : emptyProviderValues(),
    );
  }, [providerEditor, providerForm]);

  useEffect(() => {
    if (!providerModelEditor) return;
    setModelProbeText(null);
    setModelProbeOk(false);
    setModelCandidates([]);
    providerModelForm.setFieldsValue(
      providerModelEditor.mode === 'edit'
        ? providerModelFormValues(providerModelEditor.original)
        : emptyProviderModelValues(providerModelEditor.providerId),
    );
  }, [providerModelEditor, providerModelForm]);

  /** 用当前表单值测试上游连通性；直接输入的密钥留空时，服务端沿用库里已保存的密文。 */
  async function testProviderConnection() {
    try {
      const values = await providerForm.validateFields();
      setProbing(true);
      setProbeText(null);
      const outcome = await adminPost(
        'model/admin/provider/models',
        { provider: toProviderInput(values) },
        (data) => providerModelsViewSchema.parse(data),
      );
      if (outcome.ok) {
        const ids = outcome.data.models.slice(0, 20).map((model) => model.id).join('、');
        const suffix = outcome.data.models.length > 20 ? ' 等' : '';
        setProbeText(`连接正常，共 ${outcome.data.models.length} 个模型${modelListLimitHint(outcome.data.models.length)}：${ids}${suffix}`);
      } else {
        setProbeText(outcome.message);
      }
    } catch {
    } finally {
      setProbing(false);
    }
  }

  /** 拉取上游候选；只用于发现，已登记模型不会因为列表变化被清空或改写。 */
  async function loadModelCandidates() {
    if (!config || !providerModelEditor) return;
    const providerId = providerModelEditor.mode === 'edit'
      ? providerModelEditor.original.providerId
      : providerModelForm.getFieldValue('providerId');
    const provider = config.providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      message.warning('请先选择提供商');
      return;
    }
    setModelProbing(true);
    setModelProbeText(null);
    setModelProbeOk(false);
    const outcome = await adminPost(
      'model/admin/provider/models',
      { provider: providerWriteFromView(provider) },
      (data) => providerModelsViewSchema.parse(data),
    );
    setModelProbing(false);
    if (!outcome.ok) {
      setModelProbeText(outcome.message);
      return;
    }
    setModelCandidates(outcome.data.models);
    setModelProbeOk(true);
    setModelProbeText(`获取到 ${outcome.data.models.length} 个上游模型${modelListLimitHint(outcome.data.models.length)}`);
  }

  async function submitProviderModel(applyImmediately: boolean) {
    try {
      const values = await providerModelForm.validateFields();
      await saveProviderModel(values, applyImmediately);
    } catch {
    }
  }

  async function saveProviderModel(values: ProviderModelFormValues, applyImmediately: boolean) {
    if (!config || !providerModelEditor) return;
    const model: ProviderModelInput = {
      providerId: values.providerId,
      upstreamModelName: values.upstreamModelName.trim(),
      displayName: values.displayName.trim(),
      capabilities: normalizeCapabilities(values.capabilities),
      compatibility: { reasoningContentPassthrough: Boolean(values.compatibility?.reasoningContentPassthrough) },
      enabled: Boolean(values.enabled),
    };
    const creating = providerModelEditor.mode === 'create';
    await runOperation(
      () => adminPost(
        creating ? 'model/admin/provider-model/create' : 'model/admin/provider-model/update',
        creating
          ? { model, expectedRevision: config.revision, applyImmediately }
          : {
              id: providerModelEditor.original.id,
              update: {
                displayName: model.displayName,
                capabilities: model.capabilities,
                compatibility: model.compatibility,
                enabled: model.enabled,
              },
              expectedRevision: config.revision,
              applyImmediately,
            },
        (data) => providerModelWriteResultSchema.parse(data),
      ),
      () => setProviderModelEditor(null),
      applyImmediately ? '提供商模型已保存并立即生效' : '提供商模型已保存',
    );
  }

  useEffect(() => {
    if (!aliasEditor) return;
    aliasForm.setFieldsValue(
      'original' in aliasEditor ? aliasFormValues(aliasEditor.original) : emptyAliasValues(),
    );
  }, [aliasEditor, aliasForm]);

  async function submitProvider(applyImmediately: boolean) {
    try {
      const values = await providerForm.validateFields();
      await saveProvider(values, applyImmediately);
    } catch {
    }
  }

  async function submitAlias(applyImmediately: boolean) {
    try {
      const values = await aliasForm.validateFields();
      await saveAlias(values, applyImmediately);
    } catch {
    }
  }

  async function saveProvider(values: ProviderFormValues, applyImmediately: boolean) {
    if (!config || !providerEditor) return;
    const provider = toProviderInput(values);
    await runOperation(
      () =>
        adminPost(
          'model/admin/provider/upsert',
          { provider, expectedRevision: config.revision, applyImmediately },
          (data) => modelConfigVersionSchema.parse(data),
        ),
      () => setProviderEditor(null),
      applyImmediately ? '提供商已保存并立即生效' : '提供商已保存',
    );
  }

  async function saveAlias(values: AliasFormValues, applyImmediately: boolean) {
    if (!config || !aliasEditor) return;
    let alias: ModelAliasInput;
    try {
      alias = toAliasInput(aliasEditor.slot.slot, values, config.providerModels);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '请选择提供商模型');
      return;
    }
    await runOperation(
      () =>
        adminPost(
          'model/admin/alias/upsert',
          { alias, expectedRevision: config.revision, applyImmediately },
          (data) => modelConfigVersionSchema.parse(data),
        ),
      () => setAliasEditor(null),
      applyImmediately ? '模型分配已保存并立即生效' : '模型分配已保存',
    );
  }

  async function removeProvider(row: ModelProviderView) {
    if (!config) return;
    await runOperation(
      () =>
        adminPost(
          'model/admin/provider/delete',
          { id: row.id, expectedRevision: config.revision },
          (data) => modelConfigVersionSchema.parse(data),
        ),
      () => undefined,
      '提供商已删除',
    );
  }

  async function clearSlot(slot: ModelSlotView) {
    if (!config) return;
    await runOperation(
      () =>
        adminPost(
          'model/admin/alias/delete',
          { alias: slot.slot, expectedRevision: config.revision },
          (data) => modelConfigVersionSchema.parse(data),
        ),
      () => setAliasEditor(null),
      `已清除${slot.label}槽位的模型分配`,
    );
  }

  async function applyNow() {
    if (!config) return;
    await runOperation(
      () =>
        adminPost(
          'model/admin/apply',
          { expectedRevision: config.revision },
          (data) => modelConfigVersionSchema.parse(data),
        ),
      () => undefined,
      '已请求所有实例立即重新加载模型配置',
    );
  }

  if (loading && !config) {
    return (
      <main className={styles.adminPage}>
        <p>正在加载模型配置…</p>
      </main>
    );
  }

  if (!config) {
    return (
      <main className={styles.adminPage}>
        <Alert
          type="error"
          showIcon
          title="模型配置加载失败"
          description={error ?? '未知错误'}
          action={
            <Button size="small" onClick={() => void reload()}>
              重试
            </Button>
          }
        />
      </main>
    );
  }

  const slotCards = config.slots.map((slot) => ({
    slot,
    alias: config.aliases.find((alias) => alias.alias === slot.slot) ?? null,
  }));
  const providerName = (providerId: string) =>
    config.providers.find((provider) => provider.id === providerId)?.displayName ?? providerId;

  const providerColumns: ColumnsType<ModelProviderView> = [
    { title: 'ID', dataIndex: 'id' },
    { title: '名称', dataIndex: 'displayName' },
    {
      title: 'API 格式',
      dataIndex: 'apiFormat',
      render: (_, row) => formatLabel(config, row.apiFormat),
    },
    { title: '地址', dataIndex: 'baseUrl', render: (value: string) => <span className={styles.promptText}>{value}</span> },
    {
      title: '密钥来源',
      dataIndex: 'apiKeySource',
      render: (_, row) =>
        row.apiKeySource === 'env' ? `环境变量 ${row.apiKeyEnv}` : <span className={styles.textGray}>直接输入</span>,
    },
    {
      title: '密钥状态',
      dataIndex: 'apiKeyConfigured',
      render: (_, row) => (row.apiKeyConfigured ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      render: (value: boolean) => (value ? <Tag color="blue">启用</Tag> : <Tag>停用</Tag>),
    },
    {
      title: '选项',
      dataIndex: 'options',
      render: (_, row) => {
        const enabledOptions = formatOptionKeys(config, row.apiFormat).filter((key) => row.options[key] === true);
        if (enabledOptions.length === 0) return <span className={styles.textGray}>默认</span>;
        return enabledOptions.map((key) => <Tag key={key}>{modelProviderOptionLabels[key]}</Tag>);
      },
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, row) => (
        <Space>
          <Button size="small" onClick={() => openEditProvider(row)}>
            编辑
          </Button>
          <Popconfirm title="删除该提供商？" onConfirm={() => void removeProvider(row)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const providerModelColumns: ColumnsType<ProviderModelView> = [
    {
      title: '提供商',
      dataIndex: 'providerId',
      width: 220,
      render: (value: string) => (
        <Space orientation="vertical" size={0}>
          <span>{providerName(value)}</span>
          <span className={styles.slotName}>{value}</span>
        </Space>
      ),
    },
    {
      title: '请求 / 展示名',
      key: 'name',
      width: 260,
      render: (_, row) => (
        <Space orientation="vertical" size={0}>
          <code>{row.upstreamModelName}</code>
          <span className={styles.textGray}>{row.displayName}</span>
        </Space>
      ),
    },
    { title: '能力', dataIndex: 'capabilities', width: 240, render: (_, row) => capabilityTags(row.capabilities) },
    {
      title: '兼容',
      dataIndex: 'compatibility',
      width: 140,
      render: (_, row) =>
        row.compatibility.reasoningContentPassthrough ? <Tag>回传思考内容</Tag> : <span className={styles.textGray}>默认</span>,
    },
    {
      title: '引用槽位',
      dataIndex: 'slots',
      width: 180,
      render: (_, row) =>
        row.slots.length === 0 ? <span className={styles.textGray}>未分配</span> : row.slots.map((slot) => <Tag key={slot}>{slot}</Tag>),
    },
    {
      title: '费率',
      dataIndex: 'rate',
      width: 260,
      render: (_, row) => (
        <Space orientation="vertical" size={0}>
          {row.rate.versions === 0 ? (
            <Tag color="red">缺价</Tag>
          ) : row.rate.effectiveFrom ? (
            <span>
              miss {row.rate.creditInputMiss} · hit {row.rate.creditInputHit} · out {row.rate.creditOutput}
            </span>
          ) : (
            <Tag color="gold">只有未来价</Tag>
          )}
          <span className={styles.textGray}>
            {row.rate.versions} 个版本{row.rate.future > 0 ? `，未来 ${row.rate.future} 版` : ''}
          </span>
        </Space>
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 90,
      render: (value: boolean) => (value ? <Tag color="blue">启用</Tag> : <Tag>停用</Tag>),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_, row) => (
        <Button size="small" onClick={() => openEditProviderModel(row)} disabled={saving}>
          编辑
        </Button>
      ),
    },
  ];

  return (
    <main className={styles.adminPage}>
      <div className={styles.toolbar}>
        <h1>模型管理</h1>
        <Space>
          <Button onClick={() => void reload()} loading={loading}>
            刷新
          </Button>
          {config.initialized ? (
            <Popconfirm title="让所有实例立即重新加载模型配置？" onConfirm={() => void applyNow()}>
              <Button disabled={saving} loading={saving}>
                立即生效
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      </div>

      {error ? (
        <Alert
          type="error"
          showIcon
          title="模型配置刷新失败"
          description={error}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {conflict && !providerEditor && !aliasEditor ? (
        <Alert
          type="error"
          showIcon
          title="操作失败：模型配置已被其他操作修改"
          description={
            <Space orientation="vertical" size={4}>
              <span>{conflict}</span>
              <Space>
                <Button size="small" onClick={() => void reload()}>
                  重新加载
                </Button>
                <Button size="small" onClick={() => setConflict(null)}>
                  忽略
                </Button>
              </Space>
            </Space>
          }
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
                <p>
                  <code>npm run db:init-models</code>
                </p>
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
              {
                key: 'source',
                label: '实例配置来源',
                children:
                  config.instance.source === 'database'
                    ? '数据库'
                    : config.instance.source === 'environment'
                      ? '环境变量'
                      : '未知',
              },
              { key: 'epoch', label: '实例刷新批次', children: config.instance.refreshEpoch ?? '未加载' },
              {
                key: 'degraded',
                label: '实例状态',
                children: config.instance.degraded ? <Tag color="red">降级</Tag> : <Tag color="green">正常</Tag>,
              },
              { key: 'readAt', label: '最近读取时间', children: formatClock(config.instance.readAt) },
              { key: 'loadedAt', label: '最近加载时间', children: formatClock(config.instance.loadedAt) },
              { key: 'lastError', label: '最近错误', children: config.instance.lastError ?? '无' },
            ]}
          />

          <div className={styles.sectionHeading}>
            <h2>提供商</h2>
            <Button type="primary" onClick={openCreateProvider} disabled={saving}>
              新增提供商
            </Button>
          </div>
          <Table<ModelProviderView>
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={config.providers}
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={providerColumns}
          />

          <div className={styles.sectionHeading}>
            <h2>提供商模型</h2>
            <Space>
              <span className={styles.statusHint}>同一请求名在不同提供商下是两条身份；能力与兼容声明属于模型</span>
              <Button type="primary" onClick={() => openCreateProviderModel()} disabled={saving} aria-label="登记提供商模型">
                登记模型
              </Button>
            </Space>
          </div>
          <Table<ProviderModelView>
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={config.providerModels}
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={providerModelColumns}
            locale={{ emptyText: '还没有登记提供商模型；点击“登记模型”开始' }}
          />

          <div className={styles.sectionHeading}>
            <h2>模型分配</h2>
            <span className={styles.statusHint}>四个槽位由代码定义，这里只决定每个槽位用哪个模型</span>
          </div>
          <div className={styles.slotGrid}>
            {slotCards.map(({ slot, alias }) => {
              const linkedModel = alias?.providerModelId
                ? config.providerModels.find((model) => model.id === alias.providerModelId)
                : undefined;
              const capabilities = linkedModel?.capabilities ?? alias?.capabilities;
              const missingRate = linkedModel ? linkedModel.rate.versions === 0 : false;
              return (
              <section key={slot.slot} className={styles.slotCard} aria-label={`${slot.label}槽位`}>
                <div className={styles.slotCardHead}>
                  <strong>{slot.label}</strong>
                  {slot.optional ? <Tag>可选</Tag> : <Tag color="orange">必需</Tag>}
                  <span className={styles.slotName}>{slot.slot}</span>
                </div>
                <div className={styles.slotPurpose}>{slot.purpose}</div>
                {alias && capabilities ? (
                  <>
                    <div>
                      <span>{providerName(linkedModel?.providerId ?? alias.providerId)} / </span>
                      <code>{linkedModel?.upstreamModelName ?? alias.modelName}</code>
                    </div>
                    <div>{capabilityTags(capabilities)}</div>
                    {!linkedModel ? <div className={styles.slotImpact}>旧配置未关联提供商模型，请重新选择</div> : null}
                    {missingRate ? <div className={styles.slotImpact}>该模型还没有费率，生成会计入待处理</div> : null}
                    {alias.enabled ? null : <div className={styles.slotImpact}>已停用，实际不会使用</div>}
                  </>
                ) : (
                  <>
                    <div className={styles.textGray}>未配置</div>
                    <div className={styles.slotImpact}>{slot.missingImpact}</div>
                  </>
                )}
                <div className={styles.slotFooter}>
                  <Button size="small" onClick={() => openAliasEditor(slot, alias ?? undefined)} disabled={saving}>
                    配置
                  </Button>
                </div>
              </section>
              );
            })}
          </div>
        </>
      )}

      {/* 费率表与模型配置相互独立：模型配置没初始化时也照样要能看到与维护价格。 */}
      <RateCardPanel providerModels={config.providerModels} onChanged={() => void reload()} />

      {providerEditor ? (
        <Modal
          open
          title={(providerEditor.mode === 'create' ? '新增提供商' : '编辑提供商')}
          destroyOnHidden
          onCancel={() => {
            if (!saving) setProviderEditor(null);
          }}
          footer={
            <Space>
              <Button onClick={() => setProviderEditor(null)} disabled={saving}>
                取消
              </Button>
              <Button onClick={() => void submitProvider(true)} loading={saving}>
                保存并立即生效
              </Button>
              <Button type="primary" onClick={() => void submitProvider(false)} loading={saving}>
                保存
              </Button>
            </Space>
          }
        >
          {conflict ? <ConflictAlert message={conflict} onReload={() => void reload()} /> : null}
          <Form
            form={providerForm}
            layout="vertical"
            preserve={false}
            initialValues={providerEditor.mode === 'edit' ? providerFormValues(providerEditor.original) : emptyProviderValues()}
          >
            <Form.Item
              name="id"
              label="提供商 ID"
              tooltip="稳定的唯一标识，创建后不可修改"
              rules={[
                { required: true, message: '请输入提供商 ID' },
                { max: 64, message: '最多 64 个字符' },
                {
                  pattern: /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
                  message: '仅小写字母、数字、点、下划线、连字符，且首尾为字母或数字',
                },
              ]}
            >
              <Input disabled={providerEditor.mode === 'edit'} placeholder="例如 env-default" aria-label="提供商 ID" />
            </Form.Item>
            <Form.Item
              name="displayName"
              label="名称"
              rules={[{ required: true, message: '请输入名称' }, { max: 128, message: '最多 128 个字符' }]}
            >
              <Input aria-label="名称" />
            </Form.Item>
            <Form.Item name="apiFormat" label="API 格式" rules={[{ required: true, message: '请选择 API 格式' }]}>
              <Select
                aria-label="API 格式"
                options={config.providerFormats.map((format) => ({ value: format.value, label: format.label }))}
                onChange={(value: ProviderApiFormat) => {
                  providerForm.setFieldValue('options', pickProviderOptions(value, providerForm.getFieldValue('options')));
                }}
              />
            </Form.Item>
            <Form.Item
              name="baseUrl"
              label="地址"
              tooltip="模型服务的 base URL，必须为完整地址"
              rules={[{ required: true, message: '请输入地址' }, { max: 2048, message: '最多 2048 个字符' }]}
            >
              <Input aria-label="地址" placeholder="https://api.example.com/v1" />
            </Form.Item>
            <Form.Item name="apiKeySource" label="密钥来源" rules={[{ required: true, message: '请选择密钥来源' }]}>
              <Select
                aria-label="密钥来源"
                options={[
                  { value: 'env', label: '引用环境变量' },
                  { value: 'inline', label: '直接输入密钥' },
                ]}
              />
            </Form.Item>
            <Form.Item
              noStyle
              shouldUpdate={(previous, current) => previous.apiKeySource !== current.apiKeySource}
            >
              {({ getFieldValue }) =>
                getFieldValue('apiKeySource') === 'env' ? (
                  <Form.Item
                    name="apiKeyEnv"
                    label="密钥环境变量"
                    tooltip="只保存变量名，密钥值仍从进程环境读取"
                    rules={[{ required: true, message: '请选择密钥环境变量' }]}
                  >
                    <Select
                      aria-label="密钥环境变量"
                      options={config.allowedApiKeyEnvs.map((name) => ({ value: name, label: name }))}
                    />
                  </Form.Item>
                ) : (
                  <Form.Item
                    name="apiKey"
                    label="密钥"
                    tooltip="保存后仅以密文入库，页面不会回显；编辑时留空表示保持已保存的密钥"
                    rules={[
                      {
                        required: !(providerEditor.mode === 'edit' && providerEditor.original.apiKeySource === 'inline'),
                        message: '请输入密钥',
                      },
                      { max: 1024, message: '最多 1024 个字符' },
                    ]}
                  >
                    <Input.Password aria-label="密钥" autoComplete="new-password" placeholder="直接粘贴上游密钥" />
                  </Form.Item>
                )
              }
            </Form.Item>
            <Form.Item
              label="连通性"
              tooltip="按当前填写的地址与密钥请求一次上游 /models，只做检测，不会保存任何配置"
            >
        <Space orientation="vertical" size={4} style={{ width: '100%' }}>
                <Button onClick={() => void testProviderConnection()} loading={probing} aria-label="测试连接">
                  测试连接
                </Button>
                {probeText ? <span className={styles.textGray}>{probeText}</span> : null}
              </Space>
            </Form.Item>
            <Form.Item
              noStyle
              shouldUpdate={(previous, current) => previous.apiFormat !== current.apiFormat}
            >
              {({ getFieldValue }) => {
                const optionKeys = formatOptionKeys(config, getFieldValue('apiFormat') as ProviderApiFormat);
                const choiceKeys = optionKeys.filter(isChoiceOptionKey);
                const switchKeys = optionKeys.filter((key) => !isChoiceOptionKey(key));
                return (
                  <Form.Item label="提供商选项" tooltip="不同 API 格式支持的协议选项不同">
                    {optionKeys.length === 0 ? (
                      <span className={styles.textGray}>该 API 格式没有可配置的选项</span>
                    ) : (
                      <Space orientation="vertical" size={8}>
                        {choiceKeys.map((key) => (
                          <Space key={key} size={8}>
                            <span>{modelProviderOptionLabels[key]}</span>
                            <Form.Item name={['options', key]} noStyle>
                              <Select
                                allowClear
                                aria-label={modelProviderOptionLabels[key]}
                                placeholder="不指定"
                                options={[...modelProviderOptionChoices[key]]}
                                style={{ minWidth: 180 }}
                              />
                            </Form.Item>
                          </Space>
                        ))}
                        {switchKeys.length > 0 ? (
                          <Space size={16} wrap>
                            {switchKeys.map((key) => (
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
            <Form.Item
              label="自定义请求头"
              tooltip="随每个上游请求发送的普通 HTTP 头，例如 User-Agent、HTTP-Referer、X-Title；鉴权与传输头由系统生成，不能在这里覆盖"
            >
              <Form.List name="requestHeaders">
                {(fields, { add, remove }) => (
                  <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                    {fields.map((field) => (
                      <Space key={field.key} size={8} align="start">
                        {/* Form 级 preserve={false} 只为丢弃密钥；列表内层若不显式 preserve，值会在子树重挂载时被抹成 undefined */}
                        <Form.Item
                          preserve
                          name={[field.name, 'name']}
                          rules={[
                            { required: true, message: '请输入请求头名称' },
                            {
                              validator: (_rule, value) => {
                                if (value === undefined || value === null || value === '') return Promise.resolve();
                                const parsed = providerHeaderNameSchema.safeParse(value);
                                if (!parsed.success) {
                                  return Promise.reject(new Error(parsed.error.issues[0]?.message ?? '请求头名称不合法'));
                                }
                                const rows: ProviderHeaderRow[] = providerForm.getFieldValue('requestHeaders') ?? [];
                                const target = String(value).trim().toLowerCase();
                                const duplicated = rows.filter((row) => (row?.name ?? '').trim().toLowerCase() === target).length > 1;
                                return duplicated ? Promise.reject(new Error('请求头名称重复')) : Promise.resolve();
                              },
                            },
                          ]}
                        >
                          <Input aria-label="请求头名称" placeholder="User-Agent" />
                        </Form.Item>
                        <Form.Item
                          preserve
                          name={[field.name, 'value']}
                          rules={[
                            { required: true, message: '请输入请求头值' },
                            {
                              validator: (_rule, value) => {
                                if (value === undefined || value === null || value === '') return Promise.resolve();
                                const parsed = providerHeaderValueSchema.safeParse(value);
                                return parsed.success
                                  ? Promise.resolve()
                                  : Promise.reject(new Error(parsed.error.issues[0]?.message ?? '请求头值不合法'));
                              },
                            },
                          ]}
                        >
                          <Input aria-label="请求头值" placeholder="paimeng-ai-code-mother/1.0" />
                        </Form.Item>
                        <Button danger onClick={() => remove(field.name)} aria-label="删除请求头">
                          删除
                        </Button>
                      </Space>
                    ))}
                    <Button
                      onClick={() => add({ name: '', value: '' })}
                      disabled={fields.length >= providerHeaderLimit}
                      aria-label="添加请求头"
                    >
                      添加请求头
                    </Button>
                  </Space>
                )}
              </Form.List>
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch aria-label="启用" />
            </Form.Item>
          </Form>
        </Modal>
      ) : null}

      {providerModelEditor ? (
        <Modal
          open
          title={providerModelEditor.mode === 'create' ? '登记提供商模型' : '编辑提供商模型'}
          destroyOnHidden
          onCancel={() => {
            if (!saving) closeProviderModelEditor();
          }}
          footer={
            <Space>
              <Button onClick={closeProviderModelEditor} disabled={saving}>
                取消
              </Button>
              <Button onClick={() => void submitProviderModel(true)} loading={saving}>
                保存并立即生效
              </Button>
              <Button type="primary" onClick={() => void submitProviderModel(false)} loading={saving}>
                保存
              </Button>
            </Space>
          }
        >
          {conflict ? <ConflictAlert message={conflict} onReload={() => void reload()} /> : null}
          <Form
            form={providerModelForm}
            layout="vertical"
            preserve={false}
            initialValues={
              providerModelEditor.mode === 'edit'
                ? providerModelFormValues(providerModelEditor.original)
                : emptyProviderModelValues(providerModelEditor.providerId)
            }
          >
            <Form.Item
              name="providerId"
              label="提供商"
              rules={[{ required: true, message: '请选择提供商' }]}
              tooltip="模型身份归属于一个提供商；不同提供商可以登记同名请求模型"
            >
              <Select
                aria-label="模型提供商"
                disabled={providerModelEditor.mode === 'edit'}
                options={config.providers.map((provider) => ({
                  value: provider.id,
                  label: `${provider.displayName}（${provider.id}）`,
                }))}
              />
            </Form.Item>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 16 }}>
              <Form.Item
                name="upstreamModelName"
                label="请求模型名"
                tooltip="发往上游的实际 model 字段；创建后不可修改，改名请登记另一条模型"
                rules={[{ required: true, message: '请输入请求模型名' }, { max: 256, message: '最多 256 个字符' }]}
                style={{ flex: 1, minWidth: 0, marginBottom: 0 }}
              >
                <Input
                  aria-label="请求模型名"
                  disabled={providerModelEditor.mode === 'edit'}
                  placeholder="例如 deepseek-flash"
                  autoComplete="off"
                  onChange={(event) => {
                    if (!providerModelForm.getFieldValue('displayName')) {
                      providerModelForm.setFieldValue('displayName', event.target.value);
                    }
                  }}
                />
              </Form.Item>
              {providerModelEditor.mode === 'create' ? (
                <Button onClick={() => void loadModelCandidates()} loading={modelProbing}>
                  获取上游候选
                </Button>
              ) : null}
            </div>
            {modelProbeText ? <div className={styles.textGray}>{modelProbeText}</div> : null}
            <Form.Item noStyle shouldUpdate={(previous, current) => previous.providerId !== current.providerId}>
              {({ getFieldValue }) => {
                if (!modelProbeOk) return null;
                const providerId = getFieldValue('providerId') as string;
                const candidateIds = new Set(modelCandidates.map((candidate) => candidate.id));
                const missing = config.providerModels.filter(
                  (model) => model.providerId === providerId && !candidateIds.has(model.upstreamModelName),
                );
                return (
                  <Space orientation="vertical" size={8} style={{ marginBottom: 16 }}>
                    <Space wrap>
                      {modelCandidates.map((candidate) => {
                        const registered = config.providerModels.some(
                          (model) => model.providerId === providerId && model.upstreamModelName === candidate.id,
                        );
                        return (
                          <Tag
                            key={candidate.id}
                            color={registered ? 'green' : undefined}
                            style={{ cursor: providerModelEditor.mode === 'create' ? 'pointer' : 'default' }}
                            onClick={() => {
                              if (providerModelEditor.mode !== 'create') return;
                              providerModelForm.setFieldValue('upstreamModelName', candidate.id);
                              if (!providerModelForm.getFieldValue('displayName')) {
                                providerModelForm.setFieldValue('displayName', candidate.label);
                              }
                            }}
                          >
                            {candidate.label}
                            {registered ? ' · 已登记' : ''}
                          </Tag>
                        );
                      })}
                    </Space>
                    {missing.length > 0 ? (
                      <div className={styles.slotImpact}>
                        本次列表未返回：{missing.map((model) => model.upstreamModelName).join('、')}（本地记录与价格保留，不自动停用）
                      </div>
                    ) : null}
                    <span className={styles.statusHint}>上游列表只代表本次获取结果；未返回不等于已下架，登记仍需显式操作。</span>
                  </Space>
                );
              }}
            </Form.Item>
            <Form.Item
              name="displayName"
              label="展示名"
              rules={[{ required: true, message: '请输入展示名' }, { max: 128, message: '最多 128 个字符' }]}
            >
              <Input aria-label="模型展示名" autoComplete="off" />
            </Form.Item>
            <Form.Item label="能力" tooltip="登记时必须显式确认；不从槽位要求或同类模型自动推断">
              <Space size={16} wrap>
                {(['streaming', 'toolCalling', 'structuredOutput', 'imageInput'] as const).map((capability) => (
                  <span key={capability}>
                    <Form.Item name={['capabilities', capability]} valuePropName="checked" noStyle>
                      <Switch aria-label={`模型能力${modelCapabilityLabels[capability]}`} />
                    </Form.Item>
                    <span>{modelCapabilityLabels[capability]}</span>
                  </span>
                ))}
              </Space>
            </Form.Item>
            <Form.Item
              name={['compatibility', 'reasoningContentPassthrough']}
              label="回传思考内容"
              valuePropName="checked"
              tooltip="DeepSeek 类混合推理模型经第三方网关访问时打开：多轮回放历史消息会带上 reasoning_content"
            >
              <Switch aria-label="模型回传思考内容" />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch aria-label="模型启用" />
            </Form.Item>
          </Form>
        </Modal>
      ) : null}

      {aliasEditor ? (
        <Modal
          open
          title={`配置${aliasEditor.slot.label}`}
          destroyOnHidden
          onCancel={() => {
            if (!saving) setAliasEditor(null);
          }}
          footer={
            <Space>
              <Button onClick={() => setAliasEditor(null)} disabled={saving}>
                取消
              </Button>
              <Button onClick={() => void submitAlias(true)} loading={saving}>
                保存并立即生效
              </Button>
              <Button type="primary" onClick={() => void submitAlias(false)} loading={saving}>
                保存
              </Button>
              {aliasEditor.slot.optional && 'original' in aliasEditor ? (
                <Popconfirm title="清除这个槽位的模型分配？" onConfirm={() => void clearSlot(aliasEditor.slot)}>
                  <Button danger disabled={saving}>
                    清除分配
                  </Button>
                </Popconfirm>
              ) : null}
            </Space>
          }
        >
          {conflict ? <ConflictAlert message={conflict} onReload={() => void reload()} /> : null}
          <Form
            form={aliasForm}
            layout="vertical"
            preserve={false}
            initialValues={'original' in aliasEditor ? aliasFormValues(aliasEditor.original) : emptyAliasValues()}
          >
            <Descriptions size="small" column={1} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="槽位">
                {aliasEditor.slot.label}
                <span className={styles.slotName} style={{ marginLeft: 8 }}>
                  {aliasEditor.slot.slot}
                </span>
              </Descriptions.Item>
              <Descriptions.Item label="用途">{aliasEditor.slot.purpose}</Descriptions.Item>
            </Descriptions>
            <Form.Item
              name="providerModelId"
              label="提供商模型"
              rules={[{ required: true, message: '请选择提供商模型' }]}
            >
              <Select
                aria-label="槽位模型"
                showSearch
                optionFilterProp="label"
                placeholder="选择已登记的提供商模型"
                options={config.providerModels.map((model) => {
                  const missing = missingSlotCapabilities(aliasEditor.slot, model.capabilities);
                  const missingText = missing.length
                    ? `（缺${missing.map((requirement) => modelCapabilityLabels[requirement]).join('、')}）`
                    : '';
                  const priceText = model.rate.versions === 0 ? '（缺价）' : '';
                  return {
                    value: model.id,
                    label: `${providerName(model.providerId)} / ${model.upstreamModelName}${model.enabled ? '' : '（停用）'}${missingText}${priceText}`,
                    disabled: !model.enabled || missing.length > 0,
                  };
                })}
              />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(previous, current) => previous.providerModelId !== current.providerModelId}>
              {({ getFieldValue }) => {
                const model = config.providerModels.find((candidate) => candidate.id === getFieldValue('providerModelId'));
                if (!model) {
                  return (
                    <Alert
                      type="info"
                      showIcon
                      title="请选择一个已登记的提供商模型"
                      description="能力与兼容声明属于模型；槽位只保存采样与思考参数。"
                      style={{ marginBottom: 16 }}
                    />
                  );
                }
                return (
                  <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
                    <Descriptions.Item label="提供商">
                      {providerName(model.providerId)}（{model.providerId}）
                    </Descriptions.Item>
                    <Descriptions.Item label="请求模型名">
                      <code>{model.upstreamModelName}</code>
                    </Descriptions.Item>
                    <Descriptions.Item label="能力">{capabilityTags(model.capabilities)}</Descriptions.Item>
                    <Descriptions.Item label="兼容">
                      {model.compatibility.reasoningContentPassthrough ? (
                        <Tag>回传思考内容</Tag>
                      ) : (
                        <span className={styles.textGray}>默认</span>
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item label="费率">
                      {model.rate.versions === 0 ? (
                        <Tag color="red">缺价，生成会计入待处理</Tag>
                      ) : model.rate.effectiveFrom ? (
                        <span>
                          现行 {model.rate.creditInputMiss} / {model.rate.creditInputHit} / {model.rate.creditOutput} Credit / 1M tokens
                        </span>
                      ) : (
                        <Tag color="gold">只有未来价</Tag>
                      )}
                      {model.rate.future > 0 ? <Tag>未来 {model.rate.future} 版</Tag> : null}
                    </Descriptions.Item>
                  </Descriptions>
                );
              }}
            </Form.Item>
            <div className={styles.statusHint} style={{ marginBottom: 16 }}>
              能力与兼容声明由提供商模型决定；要改能力请编辑模型，不能在这里强行覆盖。
            </div>
            <Space size={16} wrap>
              <Form.Item
                name={['settings', 'temperature']}
                label="temperature"
                rules={[{ type: 'number', min: 0, max: 2, message: 'temperature 需在 0 到 2 之间' }]}
              >
                <InputNumber min={0} max={2} step={0.1} aria-label="temperature" />
              </Form.Item>
              <Form.Item
                name={['settings', 'topP']}
                label="topP"
                rules={[{ type: 'number', min: 0, max: 1, message: 'topP 需在 0 到 1 之间' }]}
              >
                <InputNumber min={0} max={1} step={0.05} aria-label="topP" />
              </Form.Item>
              <Form.Item
                name={['settings', 'maxOutputTokens']}
                label="最大输出 tokens"
                rules={[{ type: 'integer', min: 1, max: 1000000, message: '最大输出 tokens 需为 1 到 1000000 的整数' }]}
              >
                <InputNumber min={1} max={1000000} step={1} precision={0} aria-label="最大输出 tokens" />
              </Form.Item>
              <Form.Item
                name={['settings', 'reasoning']}
                label="思考强度"
                tooltip="AI SDK 的统一 reasoning 参数：chat 格式映射为 reasoning_effort，responses 格式映射为 reasoning.effort，Anthropic 映射为 thinking 预算"
              >
                <Select
                  allowClear
                  aria-label="思考强度"
                  placeholder="不指定"
                  style={{ minWidth: 140 }}
                  options={reasoningLevels.map((level) => ({ value: level, label: reasoningLevelLabels[level] }))}
                />
              </Form.Item>
            </Space>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch aria-label="启用" />
            </Form.Item>
          </Form>
        </Modal>
      ) : null}
    </main>
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
          <Button size="small" onClick={onReload}>
            重新加载
          </Button>
        </Space>
      }
      style={{ marginBottom: 16 }}
    />
  );
}

async function adminPost<T>(
  path: string,
  payload: unknown,
  parse: (data: unknown) => T,
): Promise<AdminOutcome<T>> {
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
      return { ok: false, status: response.status, message: '响应格式不正确' };
    }
  } catch (error) {
    if (error instanceof ApiResponseError) return { ok: false, status: error.status, message: error.message };
    return { ok: false, status: 0, message: '网络请求失败，请稍后重试' };
  }
}

function emptyProviderValues(): ProviderFormValues {
  return {
    id: '',
    displayName: '',
    apiFormat: providerApiFormats[0],
    baseUrl: '',
    apiKeySource: 'env',
    apiKeyEnv: baseModelApiKeyEnv,
    apiKey: '',
    options: {},
    requestHeaders: [],
    enabled: true,
  };
}

function providerFormValues(provider: ModelProviderView): ProviderFormValues {
  return {
    id: provider.id,
    displayName: provider.displayName,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    apiKeySource: provider.apiKeySource,
    apiKeyEnv: provider.apiKeySource === 'env' ? provider.apiKeyEnv : baseModelApiKeyEnv,
    apiKey: '',
    options: { ...provider.options },
    requestHeaders: providerHeaderRows(provider.headers),
    enabled: provider.enabled,
  };
}

/** 格式名称与可选选项都来自服务端下发的名单，界面不硬编码。 */
function formatLabel(config: ModelAdminConfigView, apiFormat: ProviderApiFormat): string {
  return config.providerFormats.find((format) => format.value === apiFormat)?.label ?? apiFormat;
}

function formatOptionKeys(config: ModelAdminConfigView, apiFormat: ProviderApiFormat): ModelProviderOptionKey[] {
  return config.providerFormats.find((format) => format.value === apiFormat)?.optionKeys ?? [];
}

/** 非布尔选项键（下拉型）的判定：渲染与取值共用，避免两处名单漂移。 */
function isChoiceOptionKey(key: ModelProviderOptionKey): key is 'thinkingSwitch' {
  return modelProviderChoiceOptionKeys.includes(key);
}

/** 只保留当前格式支持的选项值，并交给 schema 归一化（布尔开关与下拉取值都在这里过滤）。 */
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

/** 把已保存的请求头拆成表单行，编辑重开时保留原值。 */
function providerHeaderRows(headers: Record<string, string> | undefined): ProviderHeaderRow[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

/** 把表单行转成请求头 record，并丢掉名称为空的行（新增后未填写的空行不提交）。 */
function providerHeadersFromRows(rows: ProviderHeaderRow[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of rows ?? []) {
    const name = row?.name?.trim() ?? '';
    if (!name) continue;
    headers[name] = row?.value ?? '';
  }
  return headers;
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
    ? { ...common, apiKeySource: 'env', apiKeyEnv: values.apiKeyEnv }
    : { ...common, apiKeySource: 'inline', apiKey: values.apiKey ?? '' };
}

/** 由视图构造写入口径：直接输入的密钥留空，服务端会沿用已保存的密文。 */
function providerWriteFromView(provider: ModelProviderView): ModelProviderWriteInput {
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

function emptyAliasValues(): AliasFormValues {
  return { providerModelId: undefined, settings: {}, enabled: true };
}

function aliasFormValues(alias: ModelAlias): AliasFormValues {
  return {
    providerModelId: alias.providerModelId ?? undefined,
    settings: {
      temperature: alias.settings.temperature ?? null,
      topP: alias.settings.topP ?? null,
      maxOutputTokens: alias.settings.maxOutputTokens ?? null,
      reasoning: alias.settings.reasoning ?? null,
    },
    enabled: alias.enabled,
  };
}

function toAliasInput(slot: string, values: AliasFormValues, models: readonly ProviderModelView[]): ModelAliasInput {
  const model = models.find(candidate => candidate.id === values.providerModelId);
  if (!model) throw new Error('请选择提供商模型');
  const settings: ModelAliasSettings = {};
  if (typeof values.settings?.temperature === 'number') settings.temperature = values.settings.temperature;
  if (typeof values.settings?.topP === 'number') settings.topP = values.settings.topP;
  if (typeof values.settings?.maxOutputTokens === 'number') settings.maxOutputTokens = values.settings.maxOutputTokens;
  if (values.settings?.reasoning) settings.reasoning = values.settings.reasoning;
  return {
    alias: slot,
    providerModelId: model.id,
    providerId: model.providerId,
    modelName: model.upstreamModelName,
    capabilities: { ...model.capabilities },
    settings,
    enabled: Boolean(values.enabled),
  };
}

function normalizeCapabilities(capabilities: ModelAliasCapabilities): ModelAliasCapabilities {
  return {
    streaming: Boolean(capabilities.streaming),
    toolCalling: Boolean(capabilities.toolCalling),
    structuredOutput: Boolean(capabilities.structuredOutput),
    imageInput: Boolean(capabilities.imageInput),
  };
}

function emptyProviderModelValues(providerId?: string): ProviderModelFormValues {
  return {
    providerId: providerId ?? '',
    upstreamModelName: '',
    displayName: '',
    capabilities: { streaming: false, toolCalling: false, structuredOutput: false, imageInput: false },
    compatibility: { reasoningContentPassthrough: false },
    enabled: true,
  };
}

function providerModelFormValues(model: ProviderModelView): ProviderModelFormValues {
  return {
    providerId: model.providerId,
    upstreamModelName: model.upstreamModelName,
    displayName: model.displayName,
    capabilities: { ...model.capabilities },
    compatibility: { ...model.compatibility },
    enabled: model.enabled,
  };
}

function capabilityTags(capabilities: ModelAliasCapabilities) {
  const labels: [keyof ModelAliasCapabilities, string][] = [
    ['streaming', '流式'],
    ['toolCalling', '工具调用'],
    ['structuredOutput', '结构化输出'],
    ['imageInput', '图片输入'],
  ];
  const active = labels.filter(([key]) => capabilities[key]);
  if (active.length === 0) return <span className={styles.textGray}>无</span>;
  return active.map(([key, label]) => <Tag key={key}>{label}</Tag>);
}

function formatSettings(settings: ModelAliasSettings): string {
  const parts: string[] = [];
  if (settings.temperature != null) parts.push(`temperature ${settings.temperature}`);
  if (settings.topP != null) parts.push(`topP ${settings.topP}`);
  if (settings.maxOutputTokens != null) parts.push(`maxOutputTokens ${settings.maxOutputTokens}`);
  if (settings.reasoning != null) parts.push(`思考 ${reasoningLevelLabels[settings.reasoning]}`);
  if (settings.reasoningContentPassthrough) parts.push('回传思考内容');
  return parts.length > 0 ? parts.join('，') : '默认';
}

function formatClock(value: number | null): string {
  if (value === null) return '—';
  return new Date(value).toLocaleString();
}
