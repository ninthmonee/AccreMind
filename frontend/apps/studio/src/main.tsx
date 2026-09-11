import React, { createContext, useContext, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  ConfigProvider,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Popconfirm,
  Select,
  Space,
  Steps,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import {
  BookOutlined,
  InboxOutlined,
  EditOutlined,
  ImportOutlined,
  KeyOutlined,
  MenuFoldOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import { createApi, type components } from "@accremind/api-client";
import { useImportStore, useUiStore } from "./stores";
import "./style.css";

type Draft = components["schemas"]["CandidateDraft"];
type Candidate = components["schemas"]["CandidateView"];
type Experience = components["schemas"]["ExperienceView"];
type Session = components["schemas"]["SessionView"];
type Api = ReturnType<typeof createApi>;
const Context = createContext<{ api: Api; session: Session; logout: () => void } | null>(null);
const useSession = () => {
  const c = useContext(Context);
  if (!c) throw new Error("Session missing");
  return c;
};
const keyFor = (s: Session) => [
  s.actor_id,
  s.scope.organization_id,
  s.scope.team_id,
  s.scope.project_id,
  s.scope.personal_owner_id,
];
function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (!result.response.ok || result.data === undefined)
    throw new Error(`请求失败 (${result.response.status})：${JSON.stringify(result.error ?? "")}`);
  return result.data;
}
const statuses: Record<string, string> = {
  submitted: "已提交",
  processing: "处理中",
  ready_for_review: "待审核",
  published: "已发布",
  rejected: "已驳回",
  paused: "已暂停",
  deprecated: "已弃用",
  merged: "已合并",
};
const statusTag = (state: string) => (
  <Tag color={state === "published" ? "green" : state === "ready_for_review" ? "blue" : "default"}>
    {statuses[state] ?? state}
  </Tag>
);
const blank: Draft = {
  title: "",
  problem: "",
  context: "",
  solution: "",
  failed_attempts: [],
  validation: { method: "", result: "" },
  applicability: { domains: [], technologies: [], project_ids: [], phases: [], triggers: [] },
};

function Login({ onLogin }: { onLogin: (api: Api, session: Session) => void }) {
  const [mode, setMode] = useState("token");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function connect(values: Record<string, string>) {
    setBusy(true);
    setError("");
    const headers: Record<string, string> =
      mode === "token"
        ? { Authorization: `Bearer ${values.token}` }
        : {
            "X-Organization-Id": values.organization,
            "X-Actor-Id": values.actor,
            "X-Actor-Role": values.role,
          };
    if (mode === "dev" && values.team) headers["X-Team-Id"] = values.team;
    if (mode === "dev" && values.project) headers["X-Project-Id"] = values.project;
    try {
      const api = createApi(headers);
      const session = unwrap(await api.GET("/api/v1/session"));
      onLogin(api, session);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <section className="login-intro">
        <div className="brand-mark">A</div>
        <p className="eyebrow">ACCREMIND STUDIO</p>
        <h1>
          让解决过的问题，
          <br />
          成为下一次的经验。
        </h1>
        <p>
          沉淀经过验证的方案，在开发任务中召回，
          <br />
          通过人工审核持续完善团队经验库。
        </p>
        <div className="loop">
          召回经验 <span>→</span> 完成任务 <span>→</span> 审核沉淀
        </div>
      </section>
      <Card className="login-card" title="连接工作空间">
        <Tabs
          activeKey={mode}
          onChange={setMode}
          items={[
            { key: "token", label: "使用 Token" },
            { key: "dev", label: "本地开发" },
          ]}
        />
        <Form
          layout="vertical"
          onFinish={connect}
          initialValues={{
            organization: "acme",
            team: "frontend",
            project: "commerce-web",
            actor: "developer-1",
            role: "developer",
          }}
        >
          {mode === "token" ? (
            <>
              <p>使用包含 Studio 权限的 PAT。凭证仅保留在本次页面会话中。</p>
              <Form.Item name="token" label="Personal Access Token" rules={[{ required: true }]}>
                <Input.Password autoComplete="off" />
              </Form.Item>
            </>
          ) : (
            <>
              <Alert type="info" message="开发身份仅适用于本地开发环境。生产环境必须使用 PAT。" />
              <Form.Item name="organization" label="组织" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Space>
                <Form.Item name="team" label="团队">
                  <Input />
                </Form.Item>
                <Form.Item name="project" label="项目">
                  <Input />
                </Form.Item>
              </Space>
              <Form.Item name="actor" label="用户" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="role" label="角色">
                <Select
                  options={[
                    { value: "developer", label: "开发者" },
                    { value: "reviewer", label: "审核者" },
                  ]}
                />
              </Form.Item>
            </>
          )}
          {error && <Alert type="error" message={error} />}
          <Button type="primary" htmlType="submit" loading={busy} block>
            进入工作台
          </Button>
        </Form>
      </Card>
    </div>
  );
}

function Heading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="heading">
      <div>
        <p className="eyebrow">EXPERIENCE WORKSPACE</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function ErrorBox({ error }: { error: unknown }) {
  return error ? <Alert type="error" showIcon message={String(error)} /> : null;
}
function DraftView({ draft }: { draft: Draft }) {
  return (
    <div className="draft-view">
      <h2>{draft.title}</h2>
      <h3>问题</h3>
      <p>{draft.problem}</p>
      <h3>背景与约束</h3>
      <p>{draft.context}</p>
      <h3>解决方案</h3>
      <ReactMarkdown>{draft.solution}</ReactMarkdown>
      <h3>验证证据</h3>
      <p>{draft.validation.method}</p>
      <p>{draft.validation.result}</p>
      <Space wrap>
        {draft.applicability.technologies?.map((t) => (
          <Tag key={t}>{t}</Tag>
        ))}
      </Space>
    </div>
  );
}
function Library() {
  const { api, session } = useSession();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const page = Number(params.get("page") ?? 1);
  const [selected, setSelected] = useState<Experience | null>(null);
  const { message } = AntApp.useApp();
  const query = useQuery({
    queryKey: ["experiences", ...keyFor(session), q, page],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/experiences", {
          params: { query: { q, offset: (page - 1) * 20, limit: 20 } },
        }),
      ),
  });
  async function download(e: Experience) {
    try {
      const result = await api.GET("/api/v1/static-import/export/{experience_id}", {
        params: { path: { experience_id: e.experience_id } },
        parseAs: "text",
      });
      const text = unwrap(result);
      const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${e.experience_id}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      message.error(String(e));
    }
  }
  return (
    <>
      <Heading
        title="经验库"
        description="团队已经审核的经验，每一条都有来源与验证依据。"
        action={
          <Link to="/editor">
            <Button type="primary" icon={<EditOutlined />}>
              提交新经验
            </Button>
          </Link>
        }
      />
      <Card>
        <div className="toolbar">
          <Input.Search
            aria-label="搜索经验"
            placeholder="搜索问题、技术栈或解决方案"
            defaultValue={q}
            onSearch={(q) => setParams({ q, page: "1" })}
          />
          <Tag>{session.scope.project_id ?? session.scope.organization_id}</Tag>
        </div>
        <ErrorBox error={query.error} />
        <Table
          loading={query.isLoading}
          rowKey="experience_id"
          dataSource={query.data}
          pagination={false}
          locale={{
            emptyText: (
              <Empty description="经验库还是空的。导入静态文件或提交经验，审核后将在这里出现。" />
            ),
          }}
          columns={[
            {
              title: "经验",
              render: (_, r: Experience) => (
                <>
                  <Button type="link" className="row-title" onClick={() => setSelected(r)}>
                    {r.current.title}
                  </Button>
                  <div className="muted">{r.current.problem}</div>
                </>
              ),
            },
            { title: "状态", dataIndex: "status", render: statusTag },
            { title: "版本", render: (_, r: Experience) => `v${r.current.version}` },
            {
              title: "技术栈",
              render: (_, r: Experience) => (
                <Space wrap>
                  {r.current.applicability.technologies?.map((t) => (
                    <Tag key={t}>{t}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: "",
              render: (_, r: Experience) => <Button onClick={() => download(r)}>导出</Button>,
            },
          ]}
        />
        <div className="pagination">
          <Button disabled={page <= 1} onClick={() => setParams({ q, page: String(page - 1) })}>
            上一页
          </Button>
          <span>第 {page} 页</span>
          <Button
            disabled={(query.data?.length ?? 0) < 20}
            onClick={() => setParams({ q, page: String(page + 1) })}
          >
            下一页
          </Button>
        </div>
      </Card>
      <Drawer title="经验详情" width={640} open={!!selected} onClose={() => setSelected(null)}>
        {selected && (
          <>
            <Tag>v{selected.current.version}</Tag>
            <DraftView draft={selected.current} />
            <p className="muted">
              来源：{selected.current.source.type} ·{" "}
              {selected.current.source.file_id ?? selected.current.source.task_ref}
            </p>
            <Button onClick={() => download(selected)}>导出 Markdown 以修改并重新审核</Button>
          </>
        )}
      </Drawer>
    </>
  );
}
function Inbox() {
  const { api, session } = useSession();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [params, setParams] = useSearchParams();
  const state = params.get("state") ?? "";
  const [selected, setSelected] = useState<Candidate | null>(null);
  const query = useQuery({
    queryKey: ["candidates", ...keyFor(session), state],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/candidates", {
          params: {
            query: { limit: 100, state: state ? (state as Candidate["status"]) : undefined },
          },
        }),
      ),
  });
  const mutation = useMutation({
    mutationFn: async ({
      id,
      action,
    }: {
      id: string;
      action: "prepare" | "publish" | "reject";
    }) => {
      if (action === "prepare")
        return unwrap(
          await api.POST("/api/v1/candidates/{candidate_id}/prepare-review", {
            params: { path: { candidate_id: id } },
          }),
        );
      if (action === "publish")
        return unwrap(
          await api.POST("/api/v1/candidates/{candidate_id}/publish", {
            params: { path: { candidate_id: id } },
          }),
        );
      return unwrap(
        await api.POST("/api/v1/candidates/{candidate_id}/reject", {
          params: { path: { candidate_id: id } },
        }),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["candidates"] });
      qc.invalidateQueries({ queryKey: ["experiences"] });
      setSelected(null);
      message.success("操作已完成");
    },
    onError: (e) => message.error(String(e)),
  });
  const reviewer = session.role !== "developer";
  return (
    <>
      <Heading title="候选审核" description="检查适用范围、验证证据和敏感内容，再决定是否发布。" />
      <Card>
        <div className="toolbar">
          <Select
            aria-label="候选状态"
            value={state}
            onChange={(state) => setParams({ state })}
            options={[
              { value: "", label: "全部状态" },
              ...["submitted", "ready_for_review", "published", "rejected"].map((value) => ({
                value,
                label: statuses[value],
              })),
            ]}
          />
          <span className="muted">最多显示最近 100 条</span>
        </div>
        <ErrorBox error={query.error} />
        <Table
          rowKey="candidate_id"
          dataSource={query.data}
          loading={query.isLoading}
          pagination={{ pageSize: 10 }}
          columns={[
            {
              title: "候选经验",
              render: (_, r: Candidate) => (
                <Button type="link" className="row-title" onClick={() => setSelected(r)}>
                  {r.candidate.title}
                </Button>
              ),
            },
            {
              title: "来源",
              render: (_, r: Candidate) => (r.static_document ? "静态导入" : "任务提交"),
            },
            { title: "状态", dataIndex: "status", render: statusTag },
            { title: "提交者", dataIndex: "submitted_by" },
            {
              title: "操作",
              render: (_, r: Candidate) => <Button onClick={() => setSelected(r)}>查看审核</Button>,
            },
          ]}
        />
      </Card>
      <Drawer title="审核候选" width={680} open={!!selected} onClose={() => setSelected(null)}>
        {selected && (
          <>
            {statusTag(selected.status)}
            <DraftView draft={selected.candidate} />
            {selected.markdown_body && (
              <>
                <h3>补充正文</h3>
                <ReactMarkdown>{selected.markdown_body}</ReactMarkdown>
              </>
            )}
            {!!selected.duplicate_suggestions?.length && (
              <Alert
                type="warning"
                message={`可能重复：${selected.duplicate_suggestions.join(", ")}`}
              />
            )}
            <Descriptions
              column={1}
              items={[
                { key: "scope", label: "范围", children: JSON.stringify(selected.scope) },
                { key: "owner", label: "提交者", children: selected.submitted_by },
              ]}
            />
            {reviewer ? (
              <Space wrap>
                {selected.status === "submitted" && (
                  <Button
                    loading={mutation.isPending}
                    onClick={() =>
                      mutation.mutate({ id: selected.candidate_id, action: "prepare" })
                    }
                  >
                    完成预检
                  </Button>
                )}
                {selected.status === "ready_for_review" && (
                  <>
                    <Popconfirm
                      title="确认已审核并发布这条经验？"
                      onConfirm={() =>
                        mutation.mutate({ id: selected.candidate_id, action: "publish" })
                      }
                    >
                      <Button type="primary" loading={mutation.isPending}>
                        审核通过并发布
                      </Button>
                    </Popconfirm>
                    <Button
                      danger
                      onClick={() =>
                        mutation.mutate({ id: selected.candidate_id, action: "reject" })
                      }
                    >
                      驳回
                    </Button>
                  </>
                )}
                {!selected.static_document &&
                  ["submitted", "ready_for_review"].includes(selected.status) && (
                    <Link to={`/editor?id=${selected.candidate_id}`}>
                      <Button onClick={() => setSelected(null)}>编辑候选</Button>
                    </Link>
                  )}
              </Space>
            ) : (
              <Alert message="当前为开发者角色，发布需要审核者。" type="info" />
            )}
          </>
        )}
      </Drawer>
    </>
  );
}
function Editor() {
  const { api, session } = useSession();
  const [params] = useSearchParams();
  const id = params.get("id");
  const [form] = Form.useForm<Draft & { redacted?: boolean }>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const query = useQuery({
    queryKey: ["candidate", ...keyFor(session), id],
    enabled: !!id,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/candidates/{candidate_id}", {
          params: { path: { candidate_id: id! } },
        }),
      ),
  });
  useEffect(() => {
    form.resetFields();
    if (query.data) form.setFieldsValue(query.data.candidate);
  }, [form, query.data, id]);
  const mutation = useMutation({
    mutationFn: async (draft: Draft) =>
      id
        ? unwrap(
            await api.PATCH("/api/v1/candidates/{candidate_id}", {
              params: { path: { candidate_id: id } },
              body: draft,
            }),
          )
        : unwrap(
            await api.POST("/api/v1/candidates", {
              body: {
                task_id: `studio-${crypto.randomUUID()}`,
                candidate: draft,
                redaction_confirmed: true,
                idempotency_key: crypto.randomUUID(),
              },
            }),
          ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["candidates"] });
      message.success("经验已保存，等待审核");
      navigate("/inbox");
    },
    onError: (e) => message.error(String(e)),
  });
  return (
    <>
      <Heading
        title={id ? "编辑候选" : "提交经验"}
        description="记录一个已验证的问题与方案，让后续任务可以复用。"
      />
      <Card className="editor">
        <ErrorBox error={query.error} />
        <Form
          form={form}
          layout="vertical"
          initialValues={blank}
          onFinish={(values: Draft & { redacted?: boolean }) => {
            const { redacted, ...draft } = values;
            if (redacted) mutation.mutate(draft);
          }}
        >
          <Form.Item name="title" label="经验标题" rules={[{ required: true, min: 3, max: 200 }]}>
            <Input placeholder="例如：React 快速筛选时旧请求覆盖新结果" />
          </Form.Item>
          {[
            ["problem", "问题表现"],
            ["context", "背景与约束"],
            ["solution", "解决方案（支持 Markdown）"],
          ].map(([name, label]) => (
            <Form.Item key={name} name={name} label={label} rules={[{ required: true }]}>
              <Input.TextArea rows={name === "solution" ? 8 : 3} />
            </Form.Item>
          ))}
          <div className="form-grid">
            <Form.Item
              name={["validation", "method"]}
              label="验证方式"
              rules={[{ required: true }]}
            >
              <Input.TextArea rows={3} />
            </Form.Item>
            <Form.Item
              name={["validation", "result"]}
              label="验证结果"
              rules={[{ required: true }]}
            >
              <Input.TextArea rows={3} />
            </Form.Item>
          </div>
          <Form.Item name={["applicability", "technologies"]} label="适用技术栈">
            <Select mode="tags" placeholder="输入技术名称并回车" />
          </Form.Item>
          <Form.Item name={["applicability", "triggers"]} label="触发场景">
            <Select mode="tags" />
          </Form.Item>
          <Form.Item
            name="redacted"
            valuePropName="checked"
            rules={[
              {
                validator: (_, v) =>
                  v ? Promise.resolve() : Promise.reject(new Error("请确认已经检查并脱敏")),
              },
            ]}
          >
            <Checkbox>已确认验证结果，且内容不包含密钥、个人信息或完整源码。</Checkbox>
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={mutation.isPending}>
            保存并等待审核
          </Button>
        </Form>
      </Card>
    </>
  );
}
function StaticImport() {
  const { api } = useSession();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [files, setFiles] = useState<Array<{ filename: string; content: string }>>([]);
  const [confirmed, setConfirmed] = useState(false);
  const step = useImportStore((s) => s.step);
  const setStep = useImportStore((s) => s.setStep);
  const preview = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/api/v1/static-import/preview", { body: { files } })),
    onSuccess: () => setStep(1),
    onError: (e) => message.error(String(e)),
  });
  const commit = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/v1/static-import/commit", {
          body: {
            files,
            preview_hash: preview.data!.preview_hash,
            idempotency_key: crypto.randomUUID(),
            redaction_confirmed: true,
          },
        }),
      ),
    onSuccess: (r) => {
      setStep(2);
      qc.invalidateQueries({ queryKey: ["candidates"] });
      message.success(`已接收 ${r.candidate_ids.length} 条经验`);
    },
    onError: (e) => message.error(String(e)),
  });
  async function choose(list: FileList | null) {
    if (!list) return;
    const chosen = Array.from(list);
    if (
      chosen.length > 50 ||
      chosen.some((f) => f.size > 128000) ||
      chosen.reduce((n, f) => n + f.size, 0) > 2000000
    ) {
      message.error("最多 50 个文件，单文件 128KB，合计 2MB");
      return;
    }
    setFiles(
      await Promise.all(chosen.map(async (f) => ({ filename: f.name, content: await f.text() }))),
    );
    setConfirmed(false);
    preview.reset();
    commit.reset();
    setStep(0);
  }
  return (
    <>
      <Heading
        title="静态导入"
        description="将维护好的 Markdown 经验导入，先预检，再确认，最后交由人工审核。"
      />
      <Card>
        <Steps
          current={step}
          items={[{ title: "选择文件" }, { title: "检查预检结果" }, { title: "进入审核队列" }]}
        />
        <div className="upload-zone">
          <ImportOutlined />
          <h3>选择经验 Markdown 文件</h3>
          <p>UTF-8 · YAML Front Matter · 单个文件不超过 128KB</p>
          <input
            aria-label="选择 Markdown 文件"
            type="file"
            multiple
            accept=".md,.markdown"
            onChange={(e) => choose(e.target.files)}
          />
        </div>
        <Space>
          <span>{files.length} 个文件</span>
          <Button
            type="primary"
            disabled={!files.length}
            loading={preview.isPending}
            onClick={() => preview.mutate()}
          >
            执行预检
          </Button>
        </Space>
        {preview.data && (
          <>
            <Table
              className="preview-table"
              rowKey="filename"
              dataSource={preview.data.items}
              pagination={false}
              columns={[
                { title: "文件", dataIndex: "filename" },
                {
                  title: "处理结果",
                  dataIndex: "action",
                  render: (v) => (
                    <Tag color={["error", "conflict"].includes(v) ? "red" : "blue"}>{v}</Tag>
                  ),
                },
                {
                  title: "诊断",
                  render: (_, r) =>
                    r.diagnostics
                      ?.map((d) => `${d.field}${d.line ? ` 第${d.line}行` : ""}：${d.message}`)
                      .join("；"),
                },
              ]}
            />
            <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}>
              已检查预检结果，并确认内容已脱敏。
            </Checkbox>
            <div className="import-actions">
              <Button
                type="primary"
                disabled={!confirmed || !preview.data.can_commit || commit.isSuccess}
                loading={commit.isPending}
                onClick={() => commit.mutate()}
              >
                确认导入候选
              </Button>
              {commit.isSuccess && (
                <Link to="/inbox">
                  <Button>前往候选审核</Button>
                </Link>
              )}
            </div>
          </>
        )}
      </Card>
    </>
  );
}
function Tokens() {
  const { api, session } = useSession();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [created, setCreated] = useState("");
  const [form] = Form.useForm();
  const query = useQuery({
    queryKey: ["tokens", ...keyFor(session)],
    queryFn: async () => unwrap(await api.GET("/api/v1/tokens")),
  });
  const mutation = useMutation({
    mutationFn: async (body: components["schemas"]["TokenRequest"]) =>
      unwrap(await api.POST("/api/v1/tokens", { body })),
    onSuccess: (r) => {
      setCreated(r.token);
      qc.invalidateQueries({ queryKey: ["tokens"] });
      form.resetFields();
    },
    onError: (e) => message.error(String(e)),
  });
  async function revoke(id: string) {
    const r = await api.DELETE("/api/v1/tokens/{token_id}", { params: { path: { token_id: id } } });
    if (r.error) {
      message.error("撤销失败");
      return;
    }
    qc.invalidateQueries({ queryKey: ["tokens"] });
  }
  const tools = [
    "experience_recall",
    "experience_get",
    "experience_submit",
    "experience_feedback",
    "task_complete",
  ];
  return (
    <>
      <Heading
        title="访问 Token"
        description="为 Coding Agent 分配所需工具权限，按需撤销和更换凭证。"
      />
      <div className="token-grid">
        <Card title="创建 Token">
          <Form
            form={form}
            layout="vertical"
            initialValues={{ days: 30, tools }}
            onFinish={(v) => mutation.mutate(v)}
          >
            <Form.Item name="name" label="名称" rules={[{ required: true }]}>
              <Input placeholder="例如：本地 Coding Agent" />
            </Form.Item>
            <Form.Item name="days" label="有效天数">
              <InputNumber min={1} max={365} />
            </Form.Item>
            <Form.Item name="tools" label="允许的操作" rules={[{ required: true }]}>
              <Select
                mode="multiple"
                options={[...tools, "studio"].map((value) => ({ value, label: value }))}
              />
            </Form.Item>
            <Button htmlType="submit" type="primary" loading={mutation.isPending}>
              创建 Token
            </Button>
          </Form>
        </Card>
        <Card title="我的 Token">
          <ErrorBox error={query.error} />
          <Table
            rowKey="id"
            dataSource={query.data}
            loading={query.isLoading}
            columns={[
              { title: "名称", dataIndex: "name" },
              {
                title: "有效期",
                dataIndex: "expires_at",
                render: (v) => new Date(v).toLocaleDateString(),
              },
              {
                title: "状态",
                dataIndex: "revoked",
                render: (v) => <Tag>{v ? "已撤销" : "可用"}</Tag>,
              },
              {
                title: "操作",
                render: (_, r) => (
                  <Popconfirm title="撤销后将立即失效，是否继续？" onConfirm={() => revoke(r.id)}>
                    <Button danger disabled={r.revoked}>
                      撤销
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Card>
      </div>
      <Modal
        title="请保存 Token，仅显示一次"
        open={!!created}
        onCancel={() => setCreated("")}
        footer={<Button onClick={() => setCreated("")}>我已保存</Button>}
      >
        <Alert type="warning" message="关闭后无法再次查看。不要提交到代码仓库。" />
        <Typography.Paragraph copyable className="token-value">
          {created}
        </Typography.Paragraph>
      </Modal>
    </>
  );
}
function Jobs() {
  const { api, session } = useSession();
  const query = useQuery({
    queryKey: ["jobs", ...keyFor(session)],
    queryFn: async () => unwrap(await api.GET("/api/v1/jobs")),
  });
  const { message } = AntApp.useApp();
  return (
    <>
      <Heading
        title="后台处理"
        description="查看校验与索引任务；配置 Embedding 服务后可重试等待中的任务。"
      />
      <Card>
        <ErrorBox error={query.error} />
        <Table
          rowKey={(r) => String(r.id)}
          dataSource={query.data}
          loading={query.isLoading}
          columns={[
            { title: "任务", render: (_, r) => String(r.kind) },
            { title: "状态", render: (_, r) => String(r.state) },
            { title: "尝试次数", render: (_, r) => String(r.attempts) },
            { title: "错误", render: (_, r) => String(r.error_code ?? "—") },
            {
              title: "操作",
              render: (_, r) => (
                <Button
                  disabled={!["failed", "waiting_configuration"].includes(String(r.state))}
                  onClick={async () => {
                    const result = await api.POST("/api/v1/jobs/{job_id}/retry", {
                      params: { path: { job_id: String(r.id) } },
                    });
                    if (result.error) message.error("重试失败");
                    else {
                      query.refetch();
                      message.success("已重新排队");
                    }
                  }}
                >
                  重试
                </Button>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
function Shell() {
  const { session, logout } = useSession();
  const location = useLocation();
  const collapsed = useUiStore((s) => s.collapsed);
  const toggle = useUiStore((s) => s.toggle);
  const entries = [
    ["/library", "经验库", <BookOutlined />],
    ["/inbox", "候选审核", <InboxOutlined />],
    ["/editor", "提交经验", <EditOutlined />],
    ["/import", "静态导入", <ImportOutlined />],
    ["/tokens", "访问 Token", <KeyOutlined />],
    ["/jobs", "后台处理", <ThunderboltOutlined />],
  ] as const;
  return (
    <Layout className="shell">
      <Layout.Sider width={224} collapsed={collapsed} breakpoint="lg" collapsedWidth={72}>
        <div className="brand">
          <div className="brand-mark">A</div>
          {!collapsed && <strong>AccreMind</strong>}
        </div>
        <div className="nav-caption">{!collapsed && "经验工作空间"}</div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={entries.map(([key, label, icon]) => ({
            key,
            icon,
            label: <Link to={key}>{label}</Link>,
          }))}
        />
        <div className="sidebar-note">
          {!collapsed && (
            <>
              经验有来源
              <br />
              发布有审核
              <br />
              复用有反馈
            </>
          )}
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Header>
          <Space>
            <Button
              type="text"
              aria-label="切换侧栏"
              icon={<MenuFoldOutlined />}
              onClick={toggle}
            />
            <span>
              {session.scope.organization_id}{" "}
              <span className="muted">/ {session.scope.project_id ?? "组织经验"}</span>
            </span>
          </Space>
          <Space>
            <Tag>{session.role === "developer" ? "开发者" : "审核者"}</Tag>
            <span>{session.actor_id}</span>
            <Button onClick={logout}>退出</Button>
          </Space>
        </Layout.Header>
        <Layout.Content>
          <Routes>
            <Route path="/library" element={<Library />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/editor" element={<Editor />} />
            <Route path="/import" element={<StaticImport />} />
            <Route path="/tokens" element={<Tokens />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="*" element={<Navigate to="/library" replace />} />
          </Routes>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
function Root() {
  const [connection, setConnection] = useState<{ api: Api; session: Session } | null>(null);
  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#2864dc",
          borderRadius: 8,
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontSize: 14,
          colorBgLayout: "#f4f6fa",
        },
      }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            {connection ? (
              <Context.Provider
                value={{
                  ...connection,
                  logout: () => {
                    queryClient.clear();
                    setConnection(null);
                  },
                }}
              >
                <Shell />
              </Context.Provider>
            ) : (
              <Login
                onLogin={(api, session) => {
                  queryClient.clear();
                  setConnection({ api, session });
                }}
              />
            )}
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
