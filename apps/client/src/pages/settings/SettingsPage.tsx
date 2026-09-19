import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TabsNav, TabsNavList, TabsNavTab, TabsNavPanel } from "@/components/ui/tabs-nav";
import { AiTab } from "./AiTab";
import { StorageTab } from "./StorageTab";
import { TelegramTab } from "./TelegramTab";
import { EmailTab } from "./EmailTab";

function DataTab() {
  const [exporting, setExporting] = useState(false);
  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch("/api/export", { credentials: "include" });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `docmind-export-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Export all your documents, metadata, tags, categories, and saved searches as a zip file.
        Use this for backups or migrating to another instance.
      </p>
      <Button onClick={handleExport} disabled={exporting}>
        {exporting ? "Exporting..." : "Export all data"}
      </Button>
    </div>
  );
}

export function SettingsPage() {
  return (
    <div className="space-y-4">
      <h1 className="font-heading text-2xl">Settings</h1>
      <TabsNav defaultValue="ai">
        {/* Five tabs do not fit one line below md. Scrolling sideways beats wrapping or
            pushing the page wider, and the cut off last tab makes the scroll discoverable. */}
        <TabsNavList className="w-full flex-nowrap overflow-x-auto">
          <TabsNavTab value="ai" className="shrink-0">AI</TabsNavTab>
          <TabsNavTab value="storage" className="shrink-0">Storage</TabsNavTab>
          <TabsNavTab value="telegram" className="shrink-0">Telegram</TabsNavTab>
          <TabsNavTab value="email" className="shrink-0">Email</TabsNavTab>
          <TabsNavTab value="data" className="shrink-0">Data</TabsNavTab>
        </TabsNavList>
        <TabsNavPanel value="ai">
          <AiTab />
        </TabsNavPanel>
        <TabsNavPanel value="storage">
          <StorageTab />
        </TabsNavPanel>
        <TabsNavPanel value="telegram">
          <TelegramTab />
        </TabsNavPanel>
        <TabsNavPanel value="email">
          <EmailTab />
        </TabsNavPanel>
        <TabsNavPanel value="data">
          <DataTab />
        </TabsNavPanel>
      </TabsNav>
    </div>
  );
}
