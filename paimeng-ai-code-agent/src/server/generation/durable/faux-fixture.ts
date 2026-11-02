import { fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type FauxResponseFactory, type Message, type ToolCall } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import type { CodeGenType } from "@/shared/contracts";
import {
	fixtureInstall,
	fixtureLive,
	fixtureReadSteps,
	fixtureReplyText,
	fixtureWriteSteps,
	installFailedPage,
	installedPage,
	INSTALL_PACKAGE,
	INSTALL_PACKAGE_VERSION,
	missingPackageName,
	thickReactPage,
	THICK_REACT_PAGE,
} from "./fixture-content";

export const FAUX_FIXTURE_PROVIDER = "faux";
export const FAUX_FIXTURE_MODEL_ID = "fixture-1";

const QUEUE_REFILL_THRESHOLD = 4;
const QUEUE_REFILL_SIZE = 32;

export function fauxFixtureEnabled(): boolean {
	if (process.env.DURABLE_FAUX_FIXTURE !== "1") return false;
	if (process.env.NODE_ENV === "production" && process.env.ALLOW_TEST_FIXTURE !== "1") {
		throw new Error("生产环境禁止可控测试夹具模型：显式设置 ALLOW_TEST_FIXTURE=1 才允许（同 AI_MODE=fixture）");
	}
	return true;
}

export function fauxFixtureRef() {
	return { provider: FAUX_FIXTURE_PROVIDER, modelId: FAUX_FIXTURE_MODEL_ID };
}

const APP_TYPE = /当前应用类型 (html|multi_file|vue_project|react_project)/;
const TEMPLATED = /当前工程已从 \S+@\S+ 模板初始化/;
const THICK_REACT = /当前工程已从 react-ts@2\.0\.0 模板初始化/;

function messageText(message: Message): string {
	if (message.role === "system") {
		const content = typeof message.content === "string" ? [message.content] : message.content.map((block) => block.text);
		const sections = Object.values(message.sections ?? {}).filter((section): section is string => typeof section === "string");
		return [...content, ...sections].join("\n");
	}
	if (message.role === "user") {
		return typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	}
	return "";
}

type ScriptedTurn = { tool: string; args: ToolCall["arguments"] } | { tool: null };

/** 夹具模型也能看到 toolResult：装包失败时把可读原因写进页面，E2E 才能证明反馈真的到了模型。 */
function toolResultText(message: Message): string {
	if (message.role !== "toolResult") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (typeof block === "string" ? block : typeof block === "object" && block !== null && "text" in block ? String((block as { text?: unknown }).text ?? "") : ""))
		.join("\n");
}

function lastToolResultText(messages: readonly Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const text = toolResultText(messages[index]!);
		if (text) return text;
	}
	return "";
}

/** 证据用例显式用 `[ask:问题]` 让可控夹具调用真实 ask 工具；普通提示词不会命中。 */
const ASK_MARKER = /^\[ask:(.+?)\]\s*/;

function scriptedTurn(messages: readonly Message[]): ScriptedTurn {
	let lastUser = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "user") { lastUser = index; break; }
	}
	const instructions = messages.filter((message) => message.role === "system").map(messageText).join("\n");
	const type = APP_TYPE.exec(instructions)?.[1] as CodeGenType | undefined;
	if (type === undefined) return { tool: null };
	const prompt = lastUser < 0 ? "" : messageText(messages[lastUser]);
	const asked = ASK_MARKER.exec(prompt);
	if (asked) return { tool: "ask", args: { question: asked[1] } };
	const results = messages.slice(lastUser + 1).filter((message) => message.role === "toolResult").length;
	const templated = TEMPLATED.test(instructions) && (type === "react_project" || type === "vue_project");
	const thickReact = THICK_REACT.test(instructions);
	const reads = templated ? fixtureReadSteps(type, thickReact) : [];
	const read = reads[results];
	if (read) return { tool: read.tool, args: read.path === undefined ? {} : { path: read.path } };
	// `[install]` / `[install-fail]`：真的在 App runtime 里跑 pnpm，再写页面 / 写失败反馈。
	const install = fixtureInstall(prompt);
	if (install && templated && thickReact && type === "react_project") {
		const steps: ScriptedTurn[] = install === "install"
			? [
				{ tool: "shell", args: { command: `pnpm add ${INSTALL_PACKAGE}@${INSTALL_PACKAGE_VERSION} --reporter=append-only` } },
				{ tool: "write", args: { path: THICK_REACT_PAGE, content: installedPage(prompt).content } },
				{ tool: "m1_wait", args: { ms: 4000 } },
			]
			: [
				{ tool: "shell", args: { command: `pnpm add ${missingPackageName(prompt)} --reporter=append-only` } },
				{ tool: "write", args: { path: THICK_REACT_PAGE, content: installFailedPage(prompt, lastToolResultText(messages)).content } },
				{ tool: "m1_wait", args: { ms: 2000 } },
			];
		return steps[results - reads.length] ?? { tool: null };
	}
	// `[live]` 证据用例：同一轮里连续写两次同一页，中间用夹具工具等一会儿，
	// 让实时 Preview 能先显示第一版、再显示第二版（HMR 不刷新页面）。
	if (fixtureLive(prompt) && templated && thickReact && type === "react_project") {
		const live: ScriptedTurn[] = [
			{ tool: "write", args: { path: THICK_REACT_PAGE, content: thickReactPage(prompt, " · 第一版").content } },
			{ tool: "m1_wait", args: { ms: 8000 } },
			{ tool: "write", args: { path: THICK_REACT_PAGE, content: thickReactPage(prompt, " · 第二版").content } },
		];
		return live[results - reads.length] ?? { tool: null };
	}
	const file = fixtureWriteSteps(type, prompt, templated, thickReact)[results - reads.length];
	return file === undefined ? { tool: null } : { tool: "write", args: { path: file.path, content: file.content } };
}

export function fauxFixtureModels(): MutableModels {
	const faux = fauxProvider({ provider: FAUX_FIXTURE_PROVIDER, models: [{ id: FAUX_FIXTURE_MODEL_ID, contextWindow: 200_000, maxTokens: 8_192 }] });
	function step(context: Parameters<FauxResponseFactory>[0]): AssistantMessage {
		if (faux.getPendingResponseCount() < QUEUE_REFILL_THRESHOLD) faux.appendResponses(Array.from({ length: QUEUE_REFILL_SIZE }, () => step));
		const turn = scriptedTurn(context.messages);
		return turn.tool === null
			? fauxAssistantMessage(fixtureReplyText)
			: fauxAssistantMessage([fauxToolCall(turn.tool, turn.args)], { stopReason: "toolUse" });
	}
	faux.appendResponses(Array.from({ length: QUEUE_REFILL_SIZE }, () => step));
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}
