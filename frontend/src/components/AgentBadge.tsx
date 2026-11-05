// "via Claude" — marks a run an AI agent started through Desktop's local API
// (the Imference MCP server), on Activity rows and finish notices.
import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import { Badge } from "@/components/ds";
import { HoverPopover } from "@/components/ui/hover-popover";

/** A readable app name from the MCP client's name ("claude-ai" → Claude), "" = not sent. */
export function agentDisplayName(via: string | undefined): string {
  const v = (via ?? "").toLowerCase();
  if (v.includes("claude") || v.includes("anthropic")) return "Claude";
  if (v.includes("cursor")) return "Cursor";
  if (v.includes("windsurf") || v.includes("codeium")) return "Windsurf";
  if (v.includes("vscode") || v.includes("copilot")) return "VS Code";
  if (v.includes("zed")) return "Zed";
  if (v.includes("cline")) return "Cline";
  // Another client: its own name, readable ("my-agent" → "my agent").
  return (via ?? "").trim().replace(/[-_]+/g, " ").slice(0, 32);
}

export function AgentBadge({ via }: { via: string }) {
  const { t } = useTranslation();
  const name = agentDisplayName(via);
  const label = name ? t("agents.via", { name }) : t("agents.viaAgent");
  return (
    <HoverPopover content={t("agents.viaHint", { name: name || t("agents.anAgent") })} always className="inline-flex">
      <Badge tone="brand" data-testid="agent-badge">
        <Bot />
        {label}
      </Badge>
    </HoverPopover>
  );
}
