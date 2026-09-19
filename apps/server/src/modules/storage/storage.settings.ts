import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";
import { storageDriverIds, storageDriverRegistry } from "./storage.registry.js";

export const activeDriverSetting = defineSetting({
  key: "storage.activeDriver",
  schema: v.picklist(storageDriverIds),
  env: "STORAGE_DRIVER",
  default: "local",
  doc: "Which storage driver receives new uploads. It is also the storage the library shows and the only one whose files can be opened.",
});

export const storageSettingDefinitions = [
  activeDriverSetting,
  ...Object.values(storageDriverRegistry).flatMap((d) => d.settings),
];
