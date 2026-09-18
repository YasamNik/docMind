import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TabsNav, TabsNavList, TabsNavTab, TabsNavPanel } from "@/components/ui/tabs-nav";
import { AiTab } from "./AiTab";
import { StorageTab } from "./StorageTab";

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
        <TabsNavList>
          <TabsNavTab value="ai">AI</TabsNavTab>
          <TabsNavTab value="storage">Storage</TabsNavTab>
          <TabsNavTab value="data">Data</TabsNavTab>
        </TabsNavList>
        <TabsNavPanel value="ai">
          <AiTab />
        </TabsNavPanel>
        <TabsNavPanel value="storage">
          <StorageTab />
        </TabsNavPanel>
        <TabsNavPanel value="data">
          <DataTab />
        </TabsNavPanel>
      </TabsNav>
    </div>
  );
}
