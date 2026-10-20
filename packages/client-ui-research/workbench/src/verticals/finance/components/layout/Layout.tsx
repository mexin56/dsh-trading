import { Outlet, useLocation, useNavigation } from "react-router-dom";
import { Moon, Sun, Eye, EyeOff } from "lucide-react";
import { AiPageProvider } from "../../../../core/ai/pageContext";
import { FinanceAiDock } from "@/components/ui/FinanceAiDock";
import { useDarkMode } from "@/hooks/useDarkMode";
import { usePrivacyMode } from "@/hooks/usePrivacyMode";

/** Research occupies the terminal content pane; the terminal owns primary navigation. */
export function Layout() {
  const { pathname } = useLocation();
  const navigation = useNavigation();
  const theme = useDarkMode();
  const privacy = usePrivacyMode();
  return <AiPageProvider>
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground" data-research-workspace="">
      <header className="flex shrink-0 items-center justify-end gap-3 border-b border-border px-4 py-2">
        <div className="flex items-center gap-3" style={{ marginRight: "var(--ai-trigger-space, 0px)" }}>
          <button type="button" onClick={privacy.toggle} aria-pressed={privacy.on} aria-label="切换隐私模式" title="隐私模式"><span aria-hidden="true">{privacy.on ? <EyeOff size={16} /> : <Eye size={16} />}</span></button>
          <button type="button" onClick={theme.toggle} aria-label="切换研究主题" title="研究主题"><span aria-hidden="true">{theme.dark ? <Sun size={16} /> : <Moon size={16} />}</span></button>
        </div>
      </header>
      <main id="workspace-main" tabIndex={-1} className="min-h-0 flex-1 overflow-auto">
        <div className="workspace-content" aria-busy={navigation.state !== "idle"}>
          {navigation.state !== "idle" && <p role="status" className="mb-3 text-sm text-muted-foreground">正在打开页面…</p>}
          <Outlet />
        </div>
      </main>
      {pathname !== "/" && <FinanceAiDock />}
    </div>
  </AiPageProvider>;
}
