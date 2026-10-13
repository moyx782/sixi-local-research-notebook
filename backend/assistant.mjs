import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './input.mjs';
import { createModelConnection, normalizeEndpoint, protocols } from './model-connection.mjs';

const defaults = { provider: 'anthropic', model: 'claude-sonnet-4-20250514', protocol: 'builtin', endpoint: '' };
export function createAssistant(configDir, { connection = createModelConnection() } = {}) {
  const configPath = join(configDir, 'config.json');
  async function readConfig() {
    try {
      return { ...defaults, ...JSON.parse(await readFile(configPath, 'utf8')) };
    } catch (error) {
      if (error.code === 'ENOENT') return { ...defaults };
      throw error;
    }
  }
  async function writeConfig(config) {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    await chmod(configPath, 0o600);
    return config;
  }
  async function resolveConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new AppError('配置必须是 JSON 对象');
    for (const key of ['provider', 'model', 'apiKey', 'protocol', 'endpoint'])
      if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 4096 || /[\r\n\u0000]/.test(input[key])))
        throw new AppError(`${key} 必须是最多 4096 字的单行字符串`);
    const current = await readConfig();
    const next = {
      ...current,
      provider: input.provider?.trim() || current.provider,
      model: input.model?.trim() || current.model,
      protocol: input.protocol ?? current.protocol,
      endpoint: input.endpoint?.trim() ?? current.endpoint,
    };
    if (!protocols.includes(next.protocol)) throw new AppError('请选择支持的 API 协议');
    next.endpoint = normalizeEndpoint(next.protocol, next.endpoint);
    // A stored key belongs to its destination, not every future provider typed into the form.
    if (next.provider !== current.provider || next.protocol !== current.protocol || next.endpoint !== current.endpoint)
      delete next.apiKey;
    if (input.apiKey?.trim()) next.apiKey = input.apiKey.trim();
    return next;
  }
  async function saveConfig(input) {
    return writeConfig(await resolveConfig(input));
  }
  async function clearKey() {
    const config = await readConfig();
    delete config.apiKey;
    return writeConfig(config);
  }
  async function ask({ question, context = [], selectedText = '' }, cfg, options = {}) {
    if (typeof question !== 'string' || !question.trim()) throw new AppError('问题不能为空');
    if (
      !Array.isArray(context) ||
      context.some((note) => !note || typeof note !== 'object') ||
      typeof selectedText !== 'string'
    )
      throw new AppError('上下文格式无效');
    cfg ||= await readConfig();
    if (!cfg.apiKey) throw new AppError('还没有配置 API 密钥，请在 AI 设置中填写当前连接的 API Key。');
    const notes = context.map((note) => `【${note.type || '卡片'}】${note.title}\n${note.body}`).join('\n\n');
    const prompt = `你是 Local Research Notebook 里的上下文 AI。只针对用户选中的卡片和文字回答，不要假设工作区其他内容。先给直接结论和可执行动作，再用简短内容说明依据与不确定性；不要用免责声明、资料不足或建议继续研究来替代回答。\n\n选中上下文：\n${notes || '（无）'}\n\n选中的文字：\n${selectedText || '（无）'}\n\n用户问题：${question}`;
    if (cfg.protocol !== 'builtin') return connection.complete(cfg, options.test ? question : prompt, options);
    const [{ AuthStorage, createAgentSession, ModelRegistry, SessionManager }, { getModel }] =
      await Promise.all([import('@mariozechner/pi-coding-agent'), import('@mariozechner/pi-ai')]);
    const model = getModel(cfg.provider, cfg.model);
    if (!model) throw new AppError(`找不到模型：${cfg.provider}/${cfg.model}`);
    const authStorage = AuthStorage.create(join(configDir, 'auth.json'));
    authStorage.setRuntimeApiKey(cfg.provider, cfg.apiKey);
    const modelRegistry = new ModelRegistry(authStorage);
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: 'off',
      tools: [],
    });
    let answer = '';
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
        answer += event.assistantMessageEvent.delta;
    });
    try {
      await session.prompt(prompt);
      if (!answer.trim()) throw new AppError('模型未返回正文，请检查密钥、模型权限和额度', 502, 'MODEL_EMPTY_RESPONSE');
      return answer.trim();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('模型调用失败，请检查密钥、模型权限和网络', 502, 'MODEL_CONNECTION_FAILED');
    } finally {
      unsubscribe();
      session.dispose();
    }
  }
  async function testConnection(input) {
    const cfg = await resolveConfig(input);
    const started = Date.now();
    await ask({ question: 'This is a connection test. Reply with OK only.' }, cfg, { test: true });
    return { latencyMs: Date.now() - started, provider: cfg.provider, model: cfg.model, protocol: cfg.protocol, endpoint: cfg.endpoint };
  }
  return { readConfig, saveConfig, clearKey, ask, testConnection, close: () => connection.close() };
}
