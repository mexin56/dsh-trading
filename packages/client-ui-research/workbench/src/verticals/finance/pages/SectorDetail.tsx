import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Check, Copy, Send } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAiPage } from "../../../core/ai/pageContext";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import sectorsData from "@/data/sectors.json";
import { sectorSteps, sectorTabs, type SectorStep } from "@/lib/sectorPrompts";

/** 一步提示词：可复制到常用 AI，也可直接发送到右侧 DSH 会话。 */
function StepCard({ step, onSend }: { step: SectorStep; onSend: (text: string) => Promise<void> }) {
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  useEffect(() => {
    if (copied !== "ok") return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(step.prompt);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  };
  const send = async () => {
    setSending(true);
    setSent(false);
    setSendError(null);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        onSend(step.prompt),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("发送超时，请检查右侧会话是否收到后再重试")), 20_000);
        }),
      ]);
      setSent(true);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "发送失败，请重试");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      setSending(false);
    }
  };
  return (
    <GlassCard className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 font-mono text-xs font-semibold text-primary">第 {step.n} 步</span>
          <h3 className="min-w-0 text-sm font-semibold">{step.title}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => void copy()}
            className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">
            {copied === "ok" ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
            {copied === "ok" ? "已复制" : "复制"}
          </button>
          <button type="button" onClick={() => void send()} disabled={sending}
            title="直接发送到右侧大模型会话"
            className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-2.5 py-1 text-xs text-primary hover:bg-primary/25 disabled:opacity-60">
              <Send className="h-3.5 w-3.5" /> {sending ? "发送中…" : sent ? "已发送" : "发给 Agent"}
            </button>
        </div>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">看提示词全文</summary>
        <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-muted/40 p-3 font-sans text-xs leading-relaxed text-muted-foreground">{step.prompt}</pre>
      </details>
      {copied === "fail" && <p className="mt-2 text-xs text-warning">复制没成功，可以展开全文手动选中复制。</p>}
      {sendError && <p role="status" className="mt-2 text-xs text-warning">{sendError}</p>}
    </GlassCard>
  );
}

export function SectorDetail() {
  const { key } = useParams();
  const sector = sectorsData.sectors.find((s) => s.key === key);
  const send = (text: string) => new Promise<void>((resolve, reject) => {
    window.dispatchEvent(new CustomEvent("dshtrading:research-send-to-chat", { detail: { text, resolve, reject } }));
  });

  // 🔴 必须在下面那个 early return **之前**调：条件调用 hook 会让
  //    "找不到板块"和"找到了"两种渲染的 hook 数量不一致，React 直接报错。
  useAiPage(sector ? {
    key: `sector:${sector.key}`,
    title: sector.label,
    context:
      `板块：${sector.label}\n定位：${sector.tagline}\n` +
      (sector.verified && sector.nodes.length ? `已核实的产业链环节：${sector.nodes.join("、")}\n` : "") +
      `研究栏目（分步提示词，用户会逐步发来）：${sectorTabs(sector).join("、")}`,
    suggestions: ["第 1 步该先读哪些资料", "这个板块的产业链大致分几段", "哪个环节最可能卡脖子"],
  } : null);

  if (!sector) {
    return (
      <div className="py-20 text-center text-muted-foreground">
        未找到该板块。<Link to="/sectors" className="text-primary">返回产业研究</Link>
      </div>
    );
  }

  const steps = sectorSteps(sector);

  return (
    <div>
      <PageHeader
        title={sector.label}
        subtitle={sector.tagline}
        actions={(
          <Link to="/sectors" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> 产业研究
          </Link>
        )}
      />

      {sector.verified && sector.nodes.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">核心环节（{sector.nodes.length}）</h3>
          <div className="flex flex-wrap gap-2.5">
            {sector.nodes.map((n) => (
              <span key={n} className="rounded-full border border-primary/40 bg-primary/15 px-3.5 py-1.5 text-sm font-medium text-foreground shadow-glow transition-colors hover:bg-primary/25">
                {n}
              </span>
            ))}
          </div>
        </div>
      )}

      <section>
        <h3 className="text-sm font-semibold">让 AI 一步步梳理这个板块（{steps.length} 步）</h3>
        <p className="mb-3 mt-1 text-xs leading-relaxed text-muted-foreground">
          先读研报，再按栏目一页页写。按顺序来：点「发给 Agent」直接发送这一步到右侧大模型会话；
          回答下面点「存进记录」，攒成这个板块的研究笔记。也可以「复制」贴到你自己常用的 AI 里。
          这里只给研究方法，内容由 AI 当场查资料产出，每个数字都要它写明来源。
        </p>
        <div className="space-y-3">
          {steps.map((s) => <StepCard key={s.n} step={s} onSend={send} />)}
        </div>
      </section>

      <Disclaimer />
    </div>
  );
}
