import { TabsNav, TabsNavList, TabsNavTab, TabsNavPanel } from "@/components/ui/tabs-nav";
import { AiTab } from "./AiTab";
import { StorageTab } from "./StorageTab";

export function SettingsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <TabsNav defaultValue="ai">
        <TabsNavList>
          <TabsNavTab value="ai">AI</TabsNavTab>
          <TabsNavTab value="storage">Storage</TabsNavTab>
        </TabsNavList>
        <TabsNavPanel value="ai">
          <AiTab />
        </TabsNavPanel>
        <TabsNavPanel value="storage">
          <StorageTab />
        </TabsNavPanel>
      </TabsNav>
    </div>
  );
}
