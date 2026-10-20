import { Outlet, useNavigation } from "react-router-dom";
import { AiPageProvider } from "../../../../core/ai/pageContext";
import { useDarkMode } from "@/hooks/useDarkMode";

/** Research occupies the terminal content pane; the terminal owns primary navigation. */
export function Layout() {
  const navigation = useNavigation();
  useDarkMode();
  return <AiPageProvider>
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground" data-research-workspace="">
      <main id="workspace-main" tabIndex={-1} className="min-h-0 flex-1 overflow-auto">
        <div className="workspace-content" aria-busy={navigation.state !== "idle"}>
          {navigation.state !== "idle" && <p role="status" className="mb-3 text-sm text-muted-foreground">正在打开页面…</p>}
          <Outlet />
        </div>
      </main>
    </div>
  </AiPageProvider>;
}
